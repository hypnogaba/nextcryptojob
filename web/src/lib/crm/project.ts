import { isRoleKey } from "@/lib/card/roles";
import { isoTime } from "@/lib/time";
import {
  CHAINS,
  HIDDEN_NOTICE,
  SOURCE_KEYS,
  type Badges,
  type CandidateProfile,
  type CandidateSummary,
  type Chain,
  type Contact,
  type HiddenCandidate,
  type Intro,
  type RoleKey,
  type RoleScore,
  type RoleScoreDetailed,
  type ScoreBreakdown,
  type SourceKey,
  type Stage,
  type UnscoredReason,
} from "./types";
import { visibleToSql } from "./visibility";

/**
 * Анонімний профіль кандидата для компаній (специфікація CRM, 5.3): відповідь
 * будується ЛИШЕ з білого списку полів. Два рівні захисту:
 * 1. loadCandidates вибирає з бази тільки потрібні колонки: ні пошти, ні
 *    telegram_username (лише «чи є»), ні target_text, ні identities.value, ні
 *    фактів, крім трьох ончейн-джерел, з яких рахуються мережі й роки;
 * 2. проєкція копіює в відповідь лише поля з договору, вільний текст людини
 *    (місто, валюта) проходить перевірку форми.
 *
 * Не показуємо ніколи: email, telegram_username (крім знімка контакту після
 * знайомства), target_text, ніки й адреси з identities, facts_json,
 * last_active_at, дату створення акаунта.
 */

// ---------------------------------------------------------------------------
// Рядки з бази

export interface UserRow {
  id: string;
  roles: string;
  remote_mode: string | null;
  city: string | null;
  salary_min: number | null;
  salary_currency: string | null;
  contact_mode: string;
  has_telegram: number;
  contact_consent: number;
}

export interface ScoreRow {
  user_id: string;
  role: string;
  score: number | null;
  cover: number | null;
  breakdown_json: string;
  formula_version: string;
  computed_at: string;
  /** Версія формули пройшла ворота якості. */
  formula_published: number;
}

export interface IdentityRow {
  user_id: string;
  kind: string;
  verified_via: string | null;
  verified_at: string | null;
}

export interface FactRow {
  user_id: string;
  source: string;
  facts_json: string | null;
}

export interface PipelineRow {
  user_id: string;
  stage: Stage;
  tags: string;
}

export interface CandidateRows {
  user: UserRow;
  scores: ScoreRow[];
  identities: IdentityRow[];
  facts: FactRow[];
  /** undefined: викликач без компанії (гість x402), поле pipeline не показуємо. */
  pipeline?: PipelineRow | null;
}

const USER_COLUMNS = `u.id, u.roles, u.remote_mode, u.city, u.salary_min, u.salary_currency, u.contact_mode,
  (u.telegram_username IS NOT NULL AND trim(u.telegram_username) <> '') AS has_telegram,
  EXISTS (SELECT 1 FROM consents cc WHERE cc.user_id = u.id AND cc.kind = 'contact' AND cc.granted = 1) AS contact_consent`;

/**
 * Рядки для набору кандидатів одним пакетом запитів (id одним параметром JSON
 * через json_each: D1 має межу 100 параметрів). Рядок людини вибирається лише
 * під правилом видимості (visibility.ts) для цієї компанії: навіть якщо викликач
 * помилився з id, невидимий кандидат у відповідь не потрапить.
 */
export async function loadCandidates(
  db: D1Database,
  ids: readonly string[],
  companyId: string | null,
): Promise<Map<string, CandidateRows>> {
  const out = new Map<string, CandidateRows>();
  if (ids.length === 0) return out;
  const list = JSON.stringify(ids);
  const inIds = "(SELECT value FROM json_each(?))";
  const visible = visibleToSql(companyId);
  const statements = [
    db.prepare(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id IN ${inIds} AND ${visible.sql}`).bind(list, ...visible.params),
    db
      .prepare(
        `SELECT s.user_id, s.role, s.score, s.cover, s.breakdown_json, s.formula_version, s.computed_at,
                EXISTS (SELECT 1 FROM quality_runs q WHERE q.formula_version = s.formula_version AND q.passed = 1)
                  AS formula_published
           FROM scores s WHERE s.user_id IN ${inIds}`,
      )
      .bind(list),
    db
      .prepare(`SELECT user_id, kind, verified_via, verified_at FROM identities WHERE user_id IN ${inIds}`)
      .bind(list),
    db
      .prepare(
        `SELECT user_id, source, facts_json FROM source_facts
          WHERE user_id IN ${inIds} AND source IN ('evm', 'solana', 'hyperliquid')`,
      )
      .bind(list),
  ];
  if (companyId) {
    statements.push(
      db
        .prepare(`SELECT user_id, stage, tags FROM pipeline WHERE company_id = ? AND user_id IN ${inIds}`)
        .bind(companyId, list),
    );
  }
  const [users, scores, identities, facts, pipeline] = await db.batch(statements);

  for (const user of users.results as UserRow[]) {
    out.set(user.id, { user, scores: [], identities: [], facts: [], ...(companyId ? { pipeline: null } : {}) });
  }
  for (const row of scores.results as ScoreRow[]) out.get(row.user_id)?.scores.push(row);
  for (const row of identities.results as IdentityRow[]) out.get(row.user_id)?.identities.push(row);
  for (const row of facts.results as FactRow[]) out.get(row.user_id)?.facts.push(row);
  if (pipeline) {
    for (const row of pipeline.results as PipelineRow[]) {
      const c = out.get(row.user_id);
      if (c) c.pipeline = row;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Бали

/** Ролі, які реліз 1 не рахує (contracts §1). */
const NOT_SCORED: Partial<Record<RoleKey, UnscoredReason>> = {
  designer: "needs_portfolio",
  operations_support: "needs_cv",
  finance: "needs_cv",
  legal_compliance: "needs_cv",
  hr_recruiting: "needs_cv",
};

export function levelOf(score: number): number {
  return Math.min(10, Math.floor(score / 10) + 1);
}

/** Мітка для людей: "#" + перші 6 hex id у верхньому регістрі. Не ім'я. */
export function candidateLabel(id: string): string {
  return `#${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

/** Ролі, які людина обрала, у її порядку, лише відомі ключі, без повторів. */
export function chosenRoles(rolesJson: string): RoleKey[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rolesJson);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: RoleKey[] = [];
  for (const r of parsed) if (typeof r === "string" && isRoleKey(r) && !out.includes(r)) out.push(r);
  return out;
}

function parseBreakdown(json: string): Record<string, unknown> {
  try {
    const v = JSON.parse(json);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function unscoredReason(role: RoleKey, row: ScoreRow | undefined): UnscoredReason | null {
  const fixed = NOT_SCORED[role];
  if (fixed) return fixed;
  if (!row) return "pending";
  if (row.score === null) {
    const reason = parseBreakdown(row.breakdown_json).reason;
    if (typeof reason === "string") {
      if (reason.startsWith("missing_anchor")) return "missing_anchor";
      if (reason === "needs_cv" || reason === "needs_portfolio") return reason;
    }
    return "pending";
  }
  if (!row.formula_published) return "not_published";
  return null;
}

export function roleScore(role: RoleKey, row: ScoreRow | undefined): RoleScore {
  const reason = unscoredReason(role, row);
  if (reason === null && row && row.score !== null) {
    return {
      role,
      score: Math.floor(row.score),
      level: levelOf(row.score),
      coverage: clampInt(row.cover ?? 0),
      unscored_reason: null,
    };
  }
  return {
    role,
    score: null,
    level: null,
    // Покриття без балу нічого не каже про бал; для «бракує головного джерела» воно корисне.
    coverage: reason === "missing_anchor" && row?.cover !== null && row?.cover !== undefined ? clampInt(row.cover) : null,
    unscored_reason: reason,
  };
}

function clampInt(v: number): number {
  return Math.max(0, Math.min(100, Math.round(v)));
}

/** Бали всіх обраних ролей у порядку людини. */
export function roleScores(rows: CandidateRows): RoleScore[] {
  return roleScoresOf(rows.user.roles, rows.scores);
}

/** Те саме з сирих даних: JSON ролей людини і її рядки scores (картка воронки). */
export function roleScoresOf(rolesJson: string, scores: readonly ScoreRow[]): RoleScore[] {
  const byRole = new Map(scores.map((s) => [s.role, s]));
  return chosenRoles(rolesJson).map((role) => roleScore(role, byRole.get(role)));
}

/** Головна роль: задана фільтром, інакше найкраща порахована (непораховані в кінці). */
export function headlineOf(roles: RoleScore[], role?: RoleKey): RoleScore {
  if (role) return roles.find((r) => r.role === role) ?? roleScore(role, undefined);
  let best = roles[0];
  for (const r of roles) if ((r.score ?? -1) > (best.score ?? -1)) best = r;
  return best ?? roleScore("engineer", undefined);
}

const SOURCE_LABELS: Record<SourceKey, string> = {
  gh_eng: "Open-source engineering (GitHub)",
  gh_builder: "Shipping projects (GitHub)",
  x: "Reach and engagement on X",
  yt: "YouTube channel",
  media: "Media reach (stronger of X and YouTube)",
  output: "Published work (site or GitHub)",
  onchain: "Onchain history",
  trading: "Trading activity",
  site: "Personal site or blog",
  audits: "Audit contest results (Sherlock)",
  dune: "Dune Spellbook contributions",
};

/**
 * Які джерела фактів живлять бал джерела (contracts §4). Прогалину показуємо,
 * лише коли її джерело входить у ядро чи додатки ЦІЄЇ ролі: прогалина YouTube
 * нічого не каже про бал інженера.
 */
const FACTS_OF_SOURCE: Record<SourceKey, readonly string[]> = {
  gh_eng: ["github"],
  gh_builder: ["github"],
  x: ["x"],
  yt: ["youtube"],
  media: ["x", "youtube"],
  output: ["site", "github", "dune"],
  onchain: ["evm", "solana", "hyperliquid"],
  trading: ["evm", "solana", "hyperliquid"],
  site: ["site"],
  audits: ["audits"],
  dune: ["dune"],
};

/** Прогалини: лише ці ключі й лише текст "{Source} data unavailable right now". */
const GAP_NAMES: Record<string, string> = {
  x: "X",
  github: "GitHub",
  youtube: "YouTube",
  site: "Site",
  evm: "EVM wallet",
  "evm.ethereum": "Ethereum",
  "evm.base": "Base",
  "evm.arbitrum": "Arbitrum",
  "evm.optimism": "Optimism",
  solana: "Solana",
  hyperliquid: "Hyperliquid",
  audits: "Sherlock",
  dune: "Dune Spellbook",
};

function isSourceKey(k: string): k is SourceKey {
  return (SOURCE_KEYS as readonly string[]).includes(k);
}

function intOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null;
}

/** Пояснення балу: лише бали джерел 0–100, ваги й максимуми, назви прогалин. */
export function breakdownOf(row: ScoreRow): ScoreBreakdown {
  const b = parseBreakdown(row.breakdown_json);
  const entries = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.entries(v) : []);

  const core: ScoreBreakdown["core"] = [];
  for (const [source, part] of entries(b.core)) {
    if (!isSourceKey(source) || !part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    core.push({ source, label: SOURCE_LABELS[source], weight: intOrNull(p.weight) ?? 0, value: intOrNull(p.value) });
  }
  const bonus: ScoreBreakdown["bonus"] = [];
  for (const [source, part] of entries(b.bonus)) {
    if (!isSourceKey(source) || !part || typeof part !== "object") continue;
    const p = part as Record<string, unknown>;
    bonus.push({ source, label: SOURCE_LABELS[source], max: intOrNull(p.max) ?? 0, value: intOrNull(p.value) });
  }
  const relevant = new Set([...core, ...bonus].flatMap((part) => FACTS_OF_SOURCE[part.source]));
  const gaps: ScoreBreakdown["gaps"] = [];
  for (const [key] of entries(b.gaps)) {
    // Відомий ключ як є (evm.base); інакше лише джерело до крапки. Часткова прогалина гаманця
    // має в ключі початок адреси (contracts §3: solana.BGjMfx5B), і він назовні не йде.
    const source = Object.hasOwn(GAP_NAMES, key) ? key : key.split(".")[0];
    const name = Object.hasOwn(GAP_NAMES, source) ? GAP_NAMES[source] : undefined;
    if (name && relevant.has(source.split(".")[0]) && !gaps.some((g) => g.source === source)) {
      gaps.push({ source, label: `${name} data unavailable right now` });
    }
  }
  return {
    core,
    bonus,
    gaps,
    formula_version: /^[A-Za-z0-9._-]{1,16}$/.test(row.formula_version) ? row.formula_version : "unknown",
    updated_at: isoTime(row.computed_at),
  };
}

export function roleScoresDetailed(rows: CandidateRows): RoleScoreDetailed[] {
  const byRole = new Map(rows.scores.map((s) => [s.role, s]));
  return chosenRoles(rows.user.roles).map((role) => {
    const row = byRole.get(role);
    const base = roleScore(role, row);
    // Пояснення лише для версії формули, що пройшла ворота якості, і лише для ролей, які рахуються.
    const show = row && row.formula_published === 1 && !NOT_SCORED[role];
    return { ...base, breakdown: show ? breakdownOf(row) : null };
  });
}

// ---------------------------------------------------------------------------
// Мережі й роки ончейн (5.2)

const YEAR_S = 365.25 * 86400;
const EVM_CHAINS = ["ethereum", "base", "arbitrum", "optimism"] as const;

function records(v: unknown): Record<string, unknown>[] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return [];
  return Object.values(v).filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x));
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Секунди Unix; мілісекунди (якщо колись прийдуть) зводимо до секунд. */
function seconds(v: unknown): number | null {
  const n = num(v);
  if (n === null || n <= 0) return null;
  return n > 1e11 ? n / 1000 : n;
}

function factsOf(rows: FactRow[], source: string): unknown {
  const row = rows.find((f) => f.source === source);
  if (!row?.facts_json) return null;
  try {
    return JSON.parse(row.facts_json);
  } catch {
    return null;
  }
}

/**
 * Активні мережі: EVM sent > 0 або firstTs не null (кожна з ethereum/base/arbitrum/optimism);
 * Solana sigs > 0; Hyperliquid fillsRecent > 0 або volumeUsd > 0.
 */
export function deriveChains(facts: FactRow[]): Chain[] {
  const active = new Set<Chain>();
  for (const perAddress of records(factsOf(facts, "evm"))) {
    for (const chain of EVM_CHAINS) {
      const c = perAddress[chain];
      if (!c || typeof c !== "object") continue;
      const cf = c as Record<string, unknown>;
      if ((num(cf.sent) ?? 0) > 0 || seconds(cf.firstTs) !== null) active.add(chain);
    }
  }
  for (const s of records(factsOf(facts, "solana"))) if ((num(s.sigs) ?? 0) > 0) active.add("solana");
  for (const h of records(factsOf(facts, "hyperliquid"))) {
    if ((num(h.fillsRecent) ?? 0) > 0 || (num(h.volumeUsd) ?? 0) > 0) active.add("hyperliquid");
  }
  return CHAINS.filter((c) => active.has(c));
}

/** Роки ончейн: найраніший firstTs серед EVM і Solana без sigsCapped, вниз до 0/1/2/4/6. */
export function onchainYears(facts: FactRow[], now: Date): 0 | 1 | 2 | 4 | 6 | null {
  const firsts: number[] = [];
  for (const perAddress of records(factsOf(facts, "evm"))) {
    for (const chain of EVM_CHAINS) {
      const c = perAddress[chain];
      if (c && typeof c === "object") {
        const ts = seconds((c as Record<string, unknown>).firstTs);
        if (ts !== null) firsts.push(ts);
      }
    }
  }
  for (const s of records(factsOf(facts, "solana"))) {
    const ts = seconds(s.firstTs);
    if (ts !== null && s.sigsCapped !== true) firsts.push(ts);
  }
  if (firsts.length === 0) return null;
  const years = Math.max(0, (now.getTime() / 1000 - Math.min(...firsts)) / YEAR_S);
  if (years >= 6) return 6;
  if (years >= 4) return 4;
  if (years >= 2) return 2;
  if (years >= 1) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Позначки, робота, зарплата, контакт

export function badgesOf(identities: IdentityRow[]): Badges {
  const wallets = identities.filter((i) => i.kind === "evm" || i.kind === "solana");
  return {
    x_verified: identities.some((i) => i.kind === "x" && i.verified_at !== null),
    wallet: wallets.some((w) => w.verified_via === "signature" && w.verified_at !== null)
      ? "signature_verified"
      : wallets.length > 0
        ? "not_signature_verified"
        : "none",
    github_linked: identities.some((i) => i.kind === "github"),
    youtube_linked: identities.some((i) => i.kind === "youtube"),
    site_linked: identities.some((i) => i.kind === "site"),
  };
}

export function workModes(remoteMode: string | null): ("remote" | "city")[] {
  const parts = (remoteMode ?? "").split(",").map((p) => p.trim());
  return (["remote", "city"] as const).filter((m) => parts.includes(m));
}

/**
 * Місто як ввела людина, але лише схоже на назву міста: літери, пробіли,
 * крапки, апострофи, дефіси, без слів довших за 24 символи. Нік, пошта, адреса
 * гаманця чи посилання в полі міста в профіль не потрапляють.
 */
export function safeCity(city: string | null): string | null {
  const c = city?.trim().replace(/\s+/g, " ");
  if (!c || c.length > 80) return null;
  if (!/^\p{L}[\p{L}\p{M} .'’-]*$/u.test(c)) return null;
  if (c.split(/[ -]/).some((w) => w.length > 24)) return null;
  return c;
}

export function salaryFloor(amount: number | null, currency: string | null): CandidateSummary["salary_floor"] {
  if (amount === null || !Number.isInteger(amount) || amount <= 0) return null;
  const cur = currency?.trim().toUpperCase() ?? "";
  if (!/^[A-Z]{3}$/.test(cur)) return null;
  return { amount, currency: cur };
}

/** direct = Telegram-нік видно без схвалення: режим direct + нік є + чинна згода contact. */
export function contactModeOf(user: UserRow): "approval" | "direct" {
  return user.contact_mode === "direct" && user.has_telegram === 1 && user.contact_consent === 1 ? "direct" : "approval";
}

export function tagsOf(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((t): t is string => typeof t === "string") : [];
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Відповіді

export function projectSummary(rows: CandidateRows, opts: { role?: RoleKey; now: Date }): CandidateSummary {
  const roles = roleScores(rows);
  const summary: CandidateSummary = {
    candidate_id: rows.user.id,
    visibility: "visible",
    label: candidateLabel(rows.user.id),
    headline: headlineOf(roles, opts.role),
    roles,
    work: (() => {
      const modes = workModes(rows.user.remote_mode);
      return { modes, city: modes.includes("city") ? safeCity(rows.user.city) : null };
    })(),
    salary_floor: salaryFloor(rows.user.salary_min, rows.user.salary_currency),
    chains: deriveChains(rows.facts),
    onchain_years: onchainYears(rows.facts, opts.now),
    badges: badgesOf(rows.identities),
    contact_mode: contactModeOf(rows.user),
  };
  if (rows.pipeline !== undefined) {
    summary.pipeline = rows.pipeline ? { stage: rows.pipeline.stage, tags: tagsOf(rows.pipeline.tags) } : null;
  }
  return summary;
}

export function projectProfile(
  rows: CandidateRows,
  opts: { now: Date; intro: Intro | null; contact: Contact | null },
): CandidateProfile {
  return {
    ...projectSummary(rows, { now: opts.now }),
    roles_detailed: roleScoresDetailed(rows),
    intro: opts.intro,
    contact: opts.contact,
  };
}

export function projectHidden(
  candidateId: string,
  pipeline: { stage: Stage; tags: string },
  contact: Contact | null,
): HiddenCandidate {
  return {
    candidate_id: candidateId,
    visibility: "hidden",
    label: candidateLabel(candidateId),
    notice: HIDDEN_NOTICE,
    pipeline: { stage: pipeline.stage, tags: tagsOf(pipeline.tags) },
    contact,
  };
}

// ---------------------------------------------------------------------------
// Знайомства (рядок intros → Intro для компанії)

export interface IntroRow {
  id: string;
  user_id: string;
  status: Intro["status"];
  mode: Intro["mode"];
  message: string;
  hiring_for: string | null;
  role: string | null;
  job_id: string | null;
  requested_via: Intro["requested_via"];
  notified_at: string | null;
  expires_at: string;
  responded_at: string | null;
  contact_kind: Contact["kind"] | null;
  contact_value: string | null;
  webhook_state: Intro["webhook"]["state"];
  webhook_attempts: number;
  webhook_last_error: string | null;
  created_at: string;
}

export const INTRO_COLUMNS = `id, user_id, status, mode, message, hiring_for, role, job_id, requested_via, notified_at,
  expires_at, responded_at, contact_kind, contact_value, webhook_state, webhook_attempts, webhook_last_error, created_at`;

/** Контакт лише для прийнятого знайомства або відкриття в режимі direct (знімок у мить згоди). */
export function contactFromIntro(row: IntroRow): Contact | null {
  if ((row.status !== "accepted" && row.status !== "direct") || !row.contact_kind || !row.contact_value) return null;
  return {
    kind: row.contact_kind,
    value: row.contact_value,
    shared_at: isoTime(row.responded_at ?? row.created_at),
    via: row.status === "direct" ? "direct" : "intro",
  };
}

export function projectIntro(row: IntroRow): Intro {
  return {
    intro_id: row.id,
    candidate_id: row.user_id,
    status: row.status,
    mode: row.mode,
    message: row.message,
    hiring_for: row.hiring_for,
    role: row.role && isRoleKey(row.role) ? row.role : null,
    job_id: row.job_id,
    created_at: isoTime(row.created_at),
    expires_at: isoTime(row.expires_at),
    responded_at: isoTime(row.responded_at),
    requested_via: row.requested_via,
    candidate_notified: row.notified_at !== null,
    contact: contactFromIntro(row),
    webhook: { state: row.webhook_state, attempts: row.webhook_attempts, last_error: row.webhook_last_error },
  };
}

