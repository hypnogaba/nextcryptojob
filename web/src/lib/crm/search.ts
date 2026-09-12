import type { ActionContext } from "./context";
import { deriveChains, loadCandidates, onchainYears, projectSummary, type FactRow } from "./project";
import {
  ActionError,
  type EmptyReason,
  type SearchFilters,
  type SearchRequest,
  type SearchResponse,
  type Sort,
} from "./types";
import { visibleToSql, type SqlFragment } from "./visibility";

/**
 * Пошук кандидатів (специфікація CRM, 5.2).
 *
 * - Лише видимі (visibility.ts) і лише з обраною роллю; бал показуємо, коли
 *   версія формули пройшла ворота якості.
 * - Сортування за спаданням ключа, далі users.id за зростанням. Непораховані
 *   завжди після порахованих (ключ -1): відсутнє значення не випереджає справжнє.
 * - Мережі й роки ончейн у breakdown_json поки немає, тож це пост-фільтр у TS
 *   по пачках з 200 рядків, доки не набрано limit + 1 або переглянуто 2 000.
 * - Курсор: base64url(JSON) + HMAC (ключ з SESSION_SECRET через HKDF, мітка
 *   "cursor"), прив'язаний до хешу фільтрів. Сторінка 20, не більше 10 сторінок:
 *   на 10-й next_cursor = null і page_cap_reached = true, курсор 11-ї сторінки → 409.
 * - Порожня перша сторінка завжди має empty_reason.
 */

export const PAGE_SIZE = 20;
export const MAX_PAGES = 10;
const BATCH = 200;
const MAX_SCANNED = 2000;

const PUBLISHED = `(s.score IS NOT NULL
  AND EXISTS (SELECT 1 FROM quality_runs q WHERE q.formula_version = s.formula_version AND q.passed = 1))`;

/** Ключ сортування (одне число): непораховані завжди -1 або в нижньому діапазоні. */
const SORT_KEYS: Record<Sort, string> = {
  score: `CASE WHEN ${PUBLISHED} THEN s.score ELSE -1 END`,
  // Рівень, потім покриття: рівень·1000 + покриття (0–100).
  level: `CASE WHEN ${PUBLISHED} THEN MIN(10, CAST(s.score / 10 AS INTEGER) + 1) * 1000 + COALESCE(s.cover, 0) ELSE -1 END`,
  coverage: `CASE WHEN ${PUBLISHED} THEN COALESCE(s.cover, 0) ELSE -1 END`,
  // Коли людина стала видимою (згода visibility); пораховані все одно попереду.
  newest: `(CASE WHEN ${PUBLISHED} THEN 10000000000 ELSE 0 END)
    + COALESCE((SELECT CAST(strftime('%s', nc.at) AS INTEGER) FROM consents nc
                 WHERE nc.user_id = u.id AND nc.kind = 'visibility'), 0)`,
};

interface Position {
  k: number;
  id: string;
}

interface CursorPayload extends Position {
  v: 1;
  sort: Sort;
  page: number;
  fh: string;
}

// ---------------------------------------------------------------------------
// Курсор

const encoder = new TextEncoder();

/** JSON з відсортованими ключами: однакові фільтри дають однаковий хеш за будь-якого порядку полів. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec).filter((k) => rec[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(rec[k])}`).join(",")}}`;
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromB64url(text: string): Uint8Array<ArrayBuffer> | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  try {
    const bin = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function cursorKey(secret: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode("cursor") },
    base,
    { name: "HMAC", hash: "SHA-256", length: 256 },
    false,
    ["sign", "verify"],
  );
}

export async function filtersHash(filters: SearchFilters, sort: Sort): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(stableJson({ filters, sort })));
  return b64url(new Uint8Array(digest)).slice(0, 22);
}

export async function signCursor(payload: CursorPayload, secret: string): Promise<string> {
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await cursorKey(secret), encoder.encode(body));
  return `${body}.${b64url(new Uint8Array(sig))}`;
}

const INVALID_CURSOR = () =>
  new ActionError("validation_failed", 422, "This cursor is not valid for these filters. Start the search again.", {
    fields: { cursor: "Invalid or changed search." },
  });

async function readCursor(cursor: string, secret: string, sort: Sort, fh: string): Promise<CursorPayload> {
  const [body, sig, extra] = cursor.split(".");
  const bodyBytes = body ? fromB64url(body) : null;
  const sigBytes = sig ? fromB64url(sig) : null;
  if (extra !== undefined || !bodyBytes || !sigBytes) throw INVALID_CURSOR();
  const ok = await crypto.subtle.verify("HMAC", await cursorKey(secret), sigBytes, encoder.encode(body));
  if (!ok) throw INVALID_CURSOR();
  let p: CursorPayload;
  try {
    p = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    throw INVALID_CURSOR();
  }
  if (p.v !== 1 || p.sort !== sort || p.fh !== fh || typeof p.k !== "number" || typeof p.id !== "string") {
    throw INVALID_CURSOR();
  }
  if (!Number.isInteger(p.page) || p.page < 2) throw INVALID_CURSOR();
  return p;
}

// ---------------------------------------------------------------------------
// SQL

/** FROM і WHERE вибірки: видимість, обрана роль, фільтри, що йдуть у SQL. */
function baseQuery(companyId: string | null, filters: SearchFilters): SqlFragment {
  const params: (string | number | null)[] = [];
  const where: string[] = [];

  let from: string;
  if (filters.role) {
    from = `FROM users u LEFT JOIN scores s ON s.user_id = u.id AND s.role = ?`;
    params.push(filters.role);
    // Лише ролі, які людина обрала сама. CASE: json_each на зіпсованому JSON зупинив би весь запит.
    where.push(
      `CASE WHEN json_valid(u.roles) THEN EXISTS (SELECT 1 FROM json_each(u.roles) r WHERE r.value = ?) ELSE 0 END`,
    );
    params.push(filters.role);
  } else {
    // Без ролі: найкраща опублікована серед обраних людиною.
    from = `FROM users u LEFT JOIN scores s ON s.user_id = u.id AND s.role = (
      SELECT s2.role FROM scores s2
       WHERE s2.user_id = u.id
         AND CASE WHEN json_valid(u.roles) THEN s2.role IN (SELECT value FROM json_each(u.roles)) ELSE 0 END
         AND s2.score IS NOT NULL
         AND EXISTS (SELECT 1 FROM quality_runs q2 WHERE q2.formula_version = s2.formula_version AND q2.passed = 1)
       ORDER BY s2.score DESC, s2.role LIMIT 1)`;
    where.push(`CASE WHEN json_valid(u.roles) THEN json_array_length(u.roles) > 0 ELSE 0 END`);
  }

  const visible = visibleToSql(companyId);
  where.push(visible.sql);
  params.push(...visible.params);

  if (filters.min_score !== undefined) {
    where.push(`${PUBLISHED} AND s.score >= ?`);
    params.push(filters.min_score);
  }
  // Рівень з балу: level = min(10, floor(score/10) + 1).
  if (filters.min_level !== undefined) {
    where.push(`${PUBLISHED} AND s.score >= ?`);
    params.push(10 * (filters.min_level - 1));
  }
  if (filters.max_level !== undefined) {
    where.push(filters.max_level < 10 ? `${PUBLISHED} AND s.score < ?` : PUBLISHED);
    if (filters.max_level < 10) params.push(10 * filters.max_level);
  }
  if (filters.min_coverage !== undefined) {
    where.push(`${PUBLISHED} AND COALESCE(s.cover, 0) >= ?`);
    params.push(filters.min_coverage);
  }
  if (filters.x_verified) {
    where.push(`EXISTS (SELECT 1 FROM identities ix WHERE ix.user_id = u.id AND ix.kind = 'x' AND ix.verified_at IS NOT NULL)`);
  }
  if (filters.wallet_verified) {
    where.push(`EXISTS (SELECT 1 FROM identities iw WHERE iw.user_id = u.id AND iw.kind IN ('evm', 'solana')
                         AND iw.verified_via = 'signature' AND iw.verified_at IS NOT NULL)`);
  }
  if (filters.work_mode === "remote") {
    where.push(`(',' || replace(COALESCE(u.remote_mode, ''), ' ', '') || ',') LIKE '%,remote,%'`);
  } else if (filters.work_mode === "city") {
    where.push(`(',' || replace(COALESCE(u.remote_mode, ''), ' ', '') || ',') LIKE '%,city,%'
                AND lower(trim(u.city)) = lower(trim(?))`);
    params.push(filters.city ?? "");
  }
  if (filters.contact_direct) {
    where.push(`u.contact_mode = 'direct' AND u.telegram_username IS NOT NULL AND trim(u.telegram_username) <> ''
      AND EXISTS (SELECT 1 FROM consents cd WHERE cd.user_id = u.id AND cd.kind = 'contact' AND cd.granted = 1)`);
  }
  if (filters.exclude_in_pipeline && companyId) {
    where.push(`NOT EXISTS (SELECT 1 FROM pipeline p WHERE p.company_id = ? AND p.user_id = u.id)`);
    params.push(companyId);
  }

  return { sql: `${from} WHERE ${where.map((w) => `(${w})`).join(" AND ")}`, params };
}

async function fetchBatch(
  db: D1Database,
  base: SqlFragment,
  sort: Sort,
  after: Position | null,
  size: number,
): Promise<Position[]> {
  const keyset = after ? `WHERE (k < ? OR (k = ? AND id > ?))` : "";
  const res = await db
    .prepare(
      `SELECT id, k FROM (SELECT u.id AS id, ${SORT_KEYS[sort]} AS k ${base.sql})
        ${keyset}
        ORDER BY k DESC, id ASC LIMIT ${size}`,
    )
    .bind(...base.params, ...(after ? [after.k, after.k, after.id] : []))
    .all<Position>();
  return res.results;
}

async function chainFacts(db: D1Database, ids: string[]): Promise<Map<string, FactRow[]>> {
  const res = await db
    .prepare(
      `SELECT user_id, source, facts_json FROM source_facts
        WHERE user_id IN (SELECT value FROM json_each(?)) AND source IN ('evm', 'solana', 'hyperliquid')`,
    )
    .bind(JSON.stringify(ids))
    .all<FactRow>();
  const out = new Map<string, FactRow[]>();
  for (const row of res.results) out.set(row.user_id, [...(out.get(row.user_id) ?? []), row]);
  return out;
}

function hasScoreFilter(f: SearchFilters): boolean {
  return f.min_score !== undefined || f.min_level !== undefined || f.max_level !== undefined || f.min_coverage !== undefined;
}

/** Чому порожньо (лише для порожньої першої сторінки). */
async function emptyReason(
  db: D1Database,
  companyId: string | null,
  filters: SearchFilters,
): Promise<{ reason: EmptyReason; roleVisibleCount: number }> {
  const scope = baseQuery(companyId, filters.role ? { role: filters.role } : {});
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) ${scope.sql}) AS visible,
              EXISTS (SELECT 1 FROM quality_runs q WHERE q.passed = 1 AND q.formula_version =
                        (SELECT formula_version FROM scores ORDER BY computed_at DESC LIMIT 1)) AS published`,
    )
    .bind(...scope.params)
    .first<{ visible: number; published: number }>();
  const visible = row?.visible ?? 0;
  if (visible === 0) return { reason: "no_visible_candidates_for_role", roleVisibleCount: 0 };
  if (hasScoreFilter(filters) && !row?.published) return { reason: "scores_not_published", roleVisibleCount: visible };
  return { reason: "filters_too_narrow", roleVisibleCount: visible };
}

// ---------------------------------------------------------------------------
// Пошук

export async function searchCandidates(
  ctx: Pick<ActionContext, "db" | "company" | "env" | "now">,
  input: SearchRequest,
): Promise<SearchResponse> {
  const secret = ctx.env.SESSION_SECRET;
  if (!secret) throw new ActionError("not_configured", 503, "not configured: SESSION_SECRET");

  const filters = input.filters ?? {};
  const sort = input.sort ?? "score";
  const limit = input.limit ?? PAGE_SIZE;
  const companyId = ctx.company?.id ?? null;
  const fh = await filtersHash(filters, sort);

  let page = 1;
  let after: Position | null = null;
  if (input.cursor) {
    const c = await readCursor(input.cursor, secret, sort, fh);
    page = c.page;
    after = { k: c.k, id: c.id };
  }
  if (page > MAX_PAGES) {
    throw new ActionError(
      "page_cap_reached",
      409,
      "Search stops after 10 pages. Narrow the filters to see other candidates.",
      { max_pages: MAX_PAGES },
    );
  }

  const base = baseQuery(companyId, filters);
  const postFilter = (filters.chains?.length ?? 0) > 0 || filters.min_onchain_years !== undefined;
  const matched: Position[] = [];
  let scanned = 0;
  let last: Position | null = after;
  let exhausted = false;

  while (matched.length <= limit && scanned < MAX_SCANNED) {
    // Без пост-фільтра досить limit + 1 рядків; з ним беремо пачку з запасом.
    const size = postFilter ? BATCH : limit + 1;
    const rows = await fetchBatch(ctx.db, base, sort, last, size);
    const facts = postFilter && rows.length ? await chainFacts(ctx.db, rows.map((r) => r.id)) : null;
    for (const row of rows) {
      scanned++;
      last = row;
      if (facts && !passesChainFilters(facts.get(row.id) ?? [], filters, ctx.now)) continue;
      matched.push(row);
      if (matched.length > limit) break;
    }
    if (matched.length > limit) break;
    if (rows.length < size) {
      exhausted = true;
      break;
    }
  }

  const data = matched.slice(0, limit);
  let nextPos: Position | null = null;
  if (matched.length > limit) nextPos = data[data.length - 1];
  else if (!exhausted && last) nextPos = last; // переглянули 2 000 рядків: продовжимо з того ж місця

  let nextCursor: string | null = null;
  let capReached = false;
  if (nextPos) {
    if (page >= MAX_PAGES) capReached = true;
    else nextCursor = await signCursor({ v: 1, sort, k: nextPos.k, id: nextPos.id, page: page + 1, fh }, secret);
  }

  const rows = await loadCandidates(ctx.db, data.map((d) => d.id), companyId);
  const summaries = data.flatMap((d) => {
    const r = rows.get(d.id);
    return r ? [projectSummary(r, { role: filters.role, now: ctx.now })] : [];
  });

  let empty: { reason: EmptyReason; roleVisibleCount: number } | null = null;
  if (summaries.length === 0 && page === 1) empty = await emptyReason(ctx.db, companyId, filters);

  return {
    data: summaries,
    next_cursor: nextCursor,
    page,
    page_cap_reached: capReached,
    empty_reason: empty?.reason ?? null,
    role_visible_count: empty?.roleVisibleCount ?? null,
  };
}

function passesChainFilters(facts: FactRow[], filters: SearchFilters, now: Date): boolean {
  if (filters.chains?.length) {
    const active = deriveChains(facts);
    if (!filters.chains.some((c) => active.includes(c))) return false;
  }
  if (filters.min_onchain_years !== undefined) {
    const years = onchainYears(facts, now);
    if (years === null || years < filters.min_onchain_years) return false;
  }
  return true;
}
