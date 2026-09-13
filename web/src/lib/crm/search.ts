import type { ActionContext } from "./context";
import { deriveChains, loadCandidates, onchainYears, projectSummary, type FactRow } from "./project";
import {
  ActionError,
  EMPTY_REASONS,
  FORMULA_VERSION,
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
 * - Лише видимі (visibility.ts: прапор, згода, хоч одна відома роль) і лише з
 *   обраною роллю; бал показуємо, коли версія формули пройшла ворота якості.
 * - Сортування за спаданням ключа, далі users.id за зростанням. Непораховані
 *   завжди після порахованих (ключ -1): відсутнє значення не випереджає справжнє.
 * - Мережі, роки ончейн і місто не латиницею перевіряє TS (пост-фільтр) по
 *   пачках з 200 рядків, доки не набрано limit + 1 або переглянуто 2 000.
 * - Курсор зашифровано AES-GCM (ключ з SESSION_SECRET через HKDF, мітка
 *   "cursor-enc", випадковий IV): клієнт не бачить ні балів, ні id, а змінений
 *   курсор не розшифровується. Позиція в курсорі це завжди рядок, який ми вже
 *   віддали (якір), плюс скільки невідповідних рядків після нього переглянуто:
 *   id і бал того, хто фільтрам не підійшов, у курсор не потрапляють.
 * - Сторінка до 20, не більше 10 сторінок: на 10-й next_cursor = null і
 *   page_cap_reached = true, курсор 11-ї сторінки → 409 page_cap_reached.
 * - Порожня перша сторінка без продовження завжди має empty_reason.
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

interface Row extends Position {
  city: string | null;
}

/** Вміст курсора (лише всередині шифру). */
interface CursorPayload {
  v: 2;
  sort: Sort;
  fh: string;
  page: number;
  /** Останній відданий рядок (null = від початку). */
  a: Position | null;
  /** Скільки рядків після якоря переглянуто без збігу. */
  skip: number;
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
  if (!/^[A-Za-z0-9_-]+$/.test(text)) return null;
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
    { name: "HKDF", hash: "SHA-256", salt: new Uint8Array(0), info: encoder.encode("cursor-enc") },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function filtersHash(filters: SearchFilters, sort: Sort): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(stableJson({ filters, sort })));
  return b64url(new Uint8Array(digest)).slice(0, 22);
}

const IV_BYTES = 12;

/** base64url(IV ‖ шифр AES-GCM з тегом). */
export async function sealCursor(payload: CursorPayload, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await cursorKey(secret), encoder.encode(JSON.stringify(payload)));
  const out = new Uint8Array(IV_BYTES + sealed.byteLength);
  out.set(iv);
  out.set(new Uint8Array(sealed), IV_BYTES);
  return b64url(out);
}

const INVALID_CURSOR = () =>
  new ActionError("validation_failed", 422, "This cursor is not valid for these filters. Start the search again.", {
    fields: { cursor: "Invalid or changed search." },
  });

export async function openCursor(cursor: string, secret: string, sort: Sort, fh: string): Promise<CursorPayload> {
  const bytes = fromB64url(cursor);
  if (!bytes || bytes.length <= IV_BYTES + 16) throw INVALID_CURSOR();
  let p: CursorPayload;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: bytes.slice(0, IV_BYTES) },
      await cursorKey(secret),
      bytes.slice(IV_BYTES),
    );
    p = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw INVALID_CURSOR();
  }
  const anchorOk = p.a === null || (typeof p.a === "object" && typeof p.a.k === "number" && typeof p.a.id === "string");
  if (p.v !== 2 || p.sort !== sort || p.fh !== fh || !anchorOk || !Number.isInteger(p.skip) || p.skip < 0) {
    throw INVALID_CURSOR();
  }
  if (!Number.isInteger(p.page) || p.page < 2) throw INVALID_CURSOR();
  return p;
}

// ---------------------------------------------------------------------------
// SQL

const ASCII = /^[\x20-\x7e]*$/;

/** Місто для порівняння: NFKC, без зайвих пробілів, нижній регістр для будь-якої абетки. */
export function normalizeCity(city: string): string {
  return city.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * FROM і WHERE вибірки: видимість, обрана роль, фільтри, що йдуть у SQL.
 * lower() у SQLite знає лише латиницю, тож місто не латиницею звіряє TS (пост-фільтр).
 */
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
    where.push(`(',' || replace(COALESCE(u.remote_mode, ''), ' ', '') || ',') LIKE '%,city,%' AND u.city IS NOT NULL`);
    const city = (filters.city ?? "").trim();
    if (ASCII.test(city)) {
      where.push(`lower(trim(u.city)) = lower(?)`);
      params.push(city);
    }
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
  offset: number,
  size: number,
): Promise<Row[]> {
  const keyset = after ? `WHERE (k < ? OR (k = ? AND id > ?))` : "";
  const res = await db
    .prepare(
      `SELECT id, k, city FROM (SELECT u.id AS id, u.city AS city, ${SORT_KEYS[sort]} AS k ${base.sql})
        ${keyset}
        ORDER BY k DESC, id ASC LIMIT ? OFFSET ?`,
    )
    .bind(...base.params, ...(after ? [after.k, after.k, after.id] : []), size, offset)
    .all<Row>();
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

/**
 * Чому порожньо (лише для порожньої першої сторінки без продовження).
 * Чинна формула = FORMULA_VERSION з договору (contracts §4), без перегляду scores.
 */
async function emptyReason(
  db: D1Database,
  companyId: string | null,
  filters: SearchFilters,
): Promise<{ reason: EmptyReason; roleVisibleCount: number }> {
  const scope = baseQuery(companyId, filters.role ? { role: filters.role } : {});
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) ${scope.sql}) AS visible,
              EXISTS (SELECT 1 FROM quality_runs q WHERE q.formula_version = ? AND q.passed = 1) AS published`,
    )
    .bind(...scope.params, FORMULA_VERSION)
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
  let anchor: Position | null = null;
  let skip = 0;
  if (input.cursor) {
    const c = await openCursor(input.cursor, secret, sort, fh);
    page = c.page;
    anchor = c.a;
    skip = c.skip;
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
  const cityPost = filters.work_mode === "city" && !ASCII.test((filters.city ?? "").trim());
  const wantCity = cityPost ? normalizeCity(filters.city ?? "") : null;
  const chainPost = (filters.chains?.length ?? 0) > 0 || filters.min_onchain_years !== undefined;
  const postFilter = chainPost || cityPost;

  const data: Position[] = [];
  let scanned = 0;
  let lastScanned: Position | null = null;
  let hasMore = false;
  let exhausted = false;

  while (!hasMore && scanned < MAX_SCANNED) {
    // Без пост-фільтра досить limit + 1 рядків; з ним беремо пачку з запасом.
    const size = postFilter ? BATCH : limit + 1;
    // Перша пачка: від якоря курсора з пропуском; далі від останнього переглянутого (лише тут, не в курсорі).
    const rows: Row[] = lastScanned
      ? await fetchBatch(ctx.db, base, sort, lastScanned, 0, size)
      : await fetchBatch(ctx.db, base, sort, anchor, skip, size);
    const facts = chainPost && rows.length ? await chainFacts(ctx.db, rows.map((r) => r.id)) : null;
    for (const row of rows) {
      scanned++;
      lastScanned = row;
      const passes =
        (!facts || passesChainFilters(facts.get(row.id) ?? [], filters, ctx.now)) &&
        (wantCity === null || (row.city !== null && normalizeCity(row.city) === wantCity));
      if (!passes) {
        skip++;
        continue;
      }
      if (data.length === limit) {
        hasMore = true; // збіг limit + 1: сторінка повна, продовжимо з останнього відданого
        break;
      }
      data.push({ k: row.k, id: row.id });
      anchor = { k: row.k, id: row.id };
      skip = 0;
    }
    if (hasMore) break;
    if (rows.length < size) {
      exhausted = true;
      break;
    }
  }

  // Продовження: сторінка повна, або переглянули 2 000 рядків і далі ще щось є.
  const more = hasMore || !exhausted;
  let nextCursor: string | null = null;
  let capReached = false;
  if (more) {
    if (page >= MAX_PAGES) capReached = true;
    else nextCursor = await sealCursor({ v: 2, sort, fh, page: page + 1, a: anchor, skip }, secret);
  }

  const rows = await loadCandidates(ctx.db, data.map((d) => d.id), companyId);
  const summaries = data.flatMap((d) => {
    const r = rows.get(d.id);
    return r ? [projectSummary(r, { role: filters.role, now: ctx.now })] : [];
  });

  let empty: { reason: EmptyReason; roleVisibleCount: number } | null = null;
  if (summaries.length === 0 && page === 1 && nextCursor === null) {
    empty = await emptyReason(ctx.db, companyId, filters);
  }

  return {
    data: summaries,
    next_cursor: nextCursor,
    page,
    page_cap_reached: capReached,
    empty_reason: empty?.reason ?? null,
    role_visible_count: empty?.roleVisibleCount ?? null,
  };
}

/** Скільки збігів бере сповіщення збереженого пошуку за раз (5.7: «до 200»). */
export const MATCH_IDS_MAX = 200;

/**
 * id видимих кандидатів, що підходять під фільтри, у порядку сортування, до `max`.
 * Помічник для щоденних сповіщень збережених пошуків (cron, T11): без квоти, без
 * журналу, без курсора. Ті самі правила видимості й пост-фільтри, що й у
 * searchCandidates; переглядає не більше 2 000 рядків. Створення й зміна
 * збереженого пошуку його не викликають (там лише baseline_at).
 */
export async function matchingIds(
  ctx: Pick<ActionContext, "db" | "company" | "now">,
  filters: SearchFilters,
  sort: Sort = "score",
  max = MATCH_IDS_MAX,
): Promise<string[]> {
  const companyId = ctx.company?.id ?? null;
  const base = baseQuery(companyId, filters);
  const cityPost = filters.work_mode === "city" && !ASCII.test((filters.city ?? "").trim());
  const wantCity = cityPost ? normalizeCity(filters.city ?? "") : null;
  const chainPost = (filters.chains?.length ?? 0) > 0 || filters.min_onchain_years !== undefined;

  const ids: string[] = [];
  let scanned = 0;
  let last: Position | null = null;
  while (ids.length < max && scanned < MAX_SCANNED) {
    const rows = await fetchBatch(ctx.db, base, sort, last, 0, BATCH);
    const facts = chainPost && rows.length ? await chainFacts(ctx.db, rows.map((r) => r.id)) : null;
    for (const row of rows) {
      scanned++;
      last = row;
      const passes =
        (!facts || passesChainFilters(facts.get(row.id) ?? [], filters, ctx.now)) &&
        (wantCity === null || (row.city !== null && normalizeCity(row.city) === wantCity));
      if (passes) ids.push(row.id);
      if (ids.length === max) break;
    }
    if (rows.length < BATCH) break;
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Ідемпотентний повтор оплаченої сторінки (x402 payment-identifier)

/**
 * Що оплачена сторінка пише в meta_json свого рядка журналу `candidate.search`,
 * крім id: платіж і решту відповіді (без даних людей). Лише id і курсор, тож
 * журнал не тримає профілів, а видалений акаунт не лишає в ньому нічого, крім id.
 */
export function paidSearchMeta(paymentId: string, output: SearchResponse) {
  return {
    payment_id: paymentId,
    next_cursor: output.next_cursor,
    page_cap_reached: output.page_cap_reached ?? false,
    empty_reason: output.empty_reason ?? null,
    role_visible_count: output.role_visible_count ?? null,
  };
}

/**
 * Відповідь на ідемпотентний повтор оплаченої сторінки: ті самі кандидати в тому
 * самому порядку й той самий курсор, прочитані з рядка журналу цього платежу.
 * Пошук удруге НЕ виконується (специфікація §17), облік і журнал не пишуться.
 * Кандидати проходять правило видимості наново: хто сховався після оплати, того
 * у повторі немає. Рядка немає → null (викликач каже, що результату немає).
 */
export async function replaySearch(
  ctx: Pick<ActionContext, "db" | "company" | "now">,
  input: SearchRequest,
  paymentId: string,
): Promise<SearchResponse | null> {
  const companyId = ctx.company?.id ?? null;
  const row = companyId
    ? await ctx.db
        .prepare(
          `SELECT meta_json FROM audit_log
            WHERE actor >= ? AND actor < ? AND action = 'candidate.search'
              AND json_extract(meta_json, '$.payment_id') = ?
            ORDER BY id LIMIT 1`,
        )
        .bind(`${companyId}:`, `${companyId};`, paymentId)
        .first<{ meta_json: string }>()
    : await ctx.db
        .prepare("SELECT meta_json FROM audit_log WHERE actor = ? AND action = 'candidate.search' ORDER BY id LIMIT 1")
        .bind(`x402_guest:${paymentId}`)
        .first<{ meta_json: string }>();
  if (!row) return null;

  let meta: Record<string, unknown>;
  try {
    meta = JSON.parse(row.meta_json) as Record<string, unknown>;
  } catch {
    return null;
  }
  const ids = Array.isArray(meta.ids) ? meta.ids.filter((id): id is string => typeof id === "string") : [];
  const page = typeof meta.page === "number" ? meta.page : 1;
  const rows = await loadCandidates(ctx.db, ids, companyId);
  const data = ids.flatMap((id) => {
    const r = rows.get(id);
    return r ? [projectSummary(r, { role: input.filters?.role, now: ctx.now })] : [];
  });
  const emptyReason = (EMPTY_REASONS as readonly unknown[]).includes(meta.empty_reason)
    ? (meta.empty_reason as EmptyReason)
    : null;
  return {
    data,
    next_cursor: typeof meta.next_cursor === "string" ? meta.next_cursor : null,
    page,
    page_cap_reached: meta.page_cap_reached === true,
    empty_reason: emptyReason,
    role_visible_count: typeof meta.role_visible_count === "number" ? meta.role_visible_count : null,
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
