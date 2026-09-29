// Щогодинний прогін добірки (`digest-due`, таймер nextcryptojob-digest.timer о :05).
//
// Кому: роль задана, бал уже порахований, пауза не стоїть (users.digest_paused з 0011,
// якщо колонка є), і в поясі людини зараз її година (digest_hour), або наступна: запас
// на пропущений запуск таймера і на весняний перевід годинника, коли година 02:00 не настає.
// Один раз на дату людини: digest_runs UNIQUE(user_id, local_date).
//
// Порядок для кожної людини: підбір → один пакет (digest_runs 'pending' + рядки sent
// 'pending') → доставка → статуси. Пакет D1 = одна транзакція: або є і прогін, і рядки,
// або нічого. Друга копія прогону впирається в UNIQUE і нічого не шле.
import { randomUUID } from "node:crypto";
import type { D1Statement } from "../d1.js";
import type { Db } from "../pipeline/db.js";
import { shortError } from "../pipeline/errors.js";
import type { EngineEnv } from "../pipeline/registry.js";
import {
  type ChannelPlan, DEFAULT_SITE_URL, deliverDigest, type DeliveryJob, type DeliveryOutcome, type DeliveryUser,
  type DigestMessage, planChannel, siteUrlOf,
} from "./deliver.js";
import type { RoleKey } from "../types.js";
import { type FitContext, fitLine } from "./fit.js";
import {
  type CompanyProfile, estimateText, loadCompanyPool, loadCompanyProfiles, loadCrawlPool, type PoolStats, type SalaryEstimate,
} from "./jobs.js";
import type { JobsDb } from "./jobs-db.js";
import { countMatches, type DigestJob, type DigestPick, type DigestProfile, formatSalary, levelOfScores, selectJobs } from "./match.js";
import { isRoleKey, parseRoles } from "./roles.js";
import { tokenChip } from "./token.js";

/** Прогін, що висить 'pending' довше, уже не доставиться: процес упав між записом і відправкою. */
export const STALE_PENDING_MINUTES = 30;
export const INTERRUPTED = "interrupted before delivery";

// ---------------- час людини ----------------

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // Кидає RangeError на невідомий пояс; ловить localClock.
    f = new Intl.DateTimeFormat("en-CA", {
      timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export interface LocalClock {
  /** Година 0–23 у поясі людини. */
  hour: number;
  /** Дата людини, YYYY-MM-DD. */
  date: string;
  /** Пояс, за яким рахували (UTC, якщо свій порожній або невідомий). */
  tz: string;
  /** false, якщо users.timezone не розпізнано і взято UTC. */
  tzValid: boolean;
}

/** Година й дата в поясі людини через Intl: перевід годинника (DST) рахує сама база поясів. */
export function localClock(now: Date, timezone: string | null | undefined): LocalClock {
  const wanted = timezone?.trim() || "UTC";
  let tz = wanted;
  let f: Intl.DateTimeFormat;
  try { f = formatter(tz); } catch { tz = "UTC"; f = formatter(tz); }
  const p: Record<string, string> = {};
  for (const part of f.formatToParts(now)) p[part.type] = part.value;
  return { hour: Number(p.hour) % 24, date: `${p.year}-${p.month}-${p.day}`, tz, tzValid: tz === wanted };
}

/**
 * Чи пора: година людини = digest_hour, або наступна після неї (не через північ, бо тоді
 * це вже інша дата). Друге ловить пропущений запуск і годину, якої немає у день переводу.
 */
export function isDueHour(localHour: number, digestHour: number): boolean {
  if (!Number.isInteger(digestHour) || digestHour < 0 || digestHour > 23) return false;
  return localHour === digestHour || (digestHour < 23 && localHour === digestHour + 1);
}

// ---------------- люди ----------------

export interface DigestUserRow {
  id: string;
  roles: string;
  remote_mode: string | null;
  city: string | null;
  salary_min: number | null;
  salary_currency: string | null;
  digest_hour: number;
  timezone: string | null;
  channel: string;
  email: string | null;
  telegram_id: string | null;
  /** Що людина шукає своїми словами: для пояснення «чому» (fit.ts), не для підбору. */
  target_text?: string | null;
  /** Своя роль словами (0020); undefined, якщо міграції ще немає. */
  role_text?: string | null;
  /** Коли Telegram сказав «недосяжний» (0027); undefined, якщо міграції ще немає. */
  telegram_unreachable_at?: string | null;
}

const USER_COLUMNS = "u.id, u.roles, u.remote_mode, u.city, u.salary_min, u.salary_currency, u.digest_hour, " +
  "u.timezone, u.channel, u.email, u.telegram_id, u.target_text";
/** Своя роль словами (0020_role_text). Без міграції запит іде без неї, і збіг за словами поки не діє. */
const ROLE_TEXT_COLUMN = ", u.role_text";
/** Позначка «Telegram недосяжний» (0027_telegram_unreachable). */
const UNREACHABLE_COLUMN = ", u.telegram_unreachable_at";

/**
 * Люди, яким добірка може піти. Колонки digest_paused (0011), role_text (0020) і is_demo (0021)
 * додає web, і їх може ще не бути: тоді запит без них, а в журналі видно, що пауза чи збіг за
 * словами поки не діє. Демо-кандидатів (users.is_demo: синтетичні люди для перевірки CRM) не
 * беремо ніколи; поки 0021 не накочено, колонки немає, і демо теж немає.
 */
export async function loadDigestUsers(db: Db, log: (l: string) => void, onlyUserId?: string): Promise<DigestUserRow[]> {
  const byId = onlyUserId ? " AND u.id = ?" : "";
  const params = onlyUserId ? [onlyUserId] : [];
  const base = (extra: string) => `SELECT ${USER_COLUMNS}${extra} FROM users u WHERE u.roles <> '[]'` +
    " AND EXISTS (SELECT 1 FROM scores s WHERE s.user_id = u.id)";
  const missing = (e: unknown, column: string) =>
    e instanceof Error && new RegExp(`no such column:?\\s*(u\\.)?${column}`, "i").test(e.message);
  let extra = ROLE_TEXT_COLUMN;
  let unreachable = UNREACHABLE_COLUMN;
  let paused = " AND COALESCE(u.digest_paused, 0) = 0";
  let demo = " AND u.is_demo = 0";
  // Кожна відсутня колонка знімається раз: не більше п'яти спроб.
  for (;;) {
    try {
      return await db.query<DigestUserRow>(`${base(extra + unreachable)}${paused}${demo}${byId}`, params);
    } catch (e) {
      if (extra && missing(e, "role_text")) {
        log("digest: users.role_text missing (migration 0020 not applied), own-words matching is off");
        extra = "";
      } else if (unreachable && missing(e, "telegram_unreachable_at")) {
        log("digest: users.telegram_unreachable_at missing (migration 0027 not applied), unreachable Telegram is not remembered");
        unreachable = "";
      } else if (paused && missing(e, "digest_paused")) {
        log("digest: users.digest_paused missing (migration 0011 not applied), pause is not honoured yet");
        paused = "";
      } else if (demo && missing(e, "is_demo")) {
        // До 0021 демо-рядків ще немає, тож фільтр просто не потрібен.
        demo = "";
      } else throw e;
    }
  }
}

export function profileOf(
  u: Pick<DigestUserRow, "roles" | "remote_mode" | "city" | "salary_min" | "salary_currency" | "role_text"> &
    Partial<Pick<DigestUserRow, "target_text" | "timezone">>,
): DigestProfile {
  return {
    roles: parseRoles(u.roles), remoteMode: u.remote_mode, city: u.city?.trim() || null,
    salaryMin: u.salary_min, salaryCurrency: u.salary_currency, roleText: u.role_text?.trim() || null,
    targetText: u.target_text?.trim() || null, timezone: u.timezone?.trim() || null,
  };
}

/** Прогін, що вже є на дату людини. */
export interface ExistingRun { id: string; status: string; error: string | null; finishedAt: string | null }

/** Прогони, що вже є на дати людей. IN по user_id і межа дати йдуть індексом UNIQUE(user_id, local_date). */
async function existingRuns(db: Db, due: ReadonlyArray<{ id: string; date: string }>): Promise<Map<string, ExistingRun>> {
  const out = new Map<string, ExistingRun>();
  const minDate = due.reduce((m, d) => (d.date < m ? d.date : m), "9999-12-31");
  for (let i = 0; i < due.length; i += 90) {
    const chunk = due.slice(i, i + 90);
    const rows = await db.query<{ id: string; user_id: string; local_date: string; status: string; error: string | null; finished_at: string | null }>(
      `SELECT id, user_id, local_date, status, error, finished_at FROM digest_runs WHERE user_id IN (${chunk.map(() => "?").join(", ")}) AND local_date >= ?`,
      [...chunk.map((d) => d.id), minDate]);
    for (const r of rows) out.set(`${r.user_id}|${r.local_date}`, { id: r.id, status: r.status, error: r.error, finishedAt: r.finished_at });
  }
  return out;
}

/** Скільки хвилин мусить минути після невдалої спроби, перш ніж пробувати вдруге (не бити двічі за одну годину). */
export const RETRY_MIN_AGE_MINUTES = 20;

/**
 * Збої, після яких повтор безпечний: повідомлення точно не дійшло (Telegram 429 і 5xx, вичерпаний
 * запас очікування) або лист має той самий digest_id, і сайт відкине дубль (409 = уже надіслано).
 * НЕ повторюємо те, що могло дійти: мережевий збій Telegram (таймаут після відправки), перерваний
 * прогін (INTERRUPTED), і те, що не мине само: пошта не налаштована, бот заблокований.
 */
export function isRetryableFailure(error: string | null): boolean {
  if (!error) return false;
  return /^telegram (429|5\d\d):/.test(error) || /^email endpoint (HTTP 5\d\d|unreachable)/.test(error);
}

/** Невдалий прогін цієї дати можна пробувати знову: збій відновний і з останньої спроби минуло досить часу. */
export function canRetryRun(run: ExistingRun, now: Date): boolean {
  if (run.status !== "failed" || !isRetryableFailure(run.error)) return false;
  const at = run.finishedAt ? Date.parse(`${run.finishedAt.replace(" ", "T")}Z`) : NaN;
  const ageMin = Number.isNaN(at) ? Infinity : (now.getTime() - at) / 60_000;
  return ageMin >= RETRY_MIN_AGE_MINUTES;
}

async function sentRefs(db: Db, userId: string): Promise<Set<string>> {
  // Усі надіслані й ті, що зараз відправляються, без межі в часі: UNIQUE(user_id, job_ref) не дасть вставити
  // старий рядок удруге. 'failed' не рахуємо: доставка не вдалась, людина цих вакансій не бачила.
  const rows = await db.query<{ job_ref: string }>("SELECT job_ref FROM sent WHERE user_id = ? AND status IN ('sent', 'pending')", [userId]);
  return new Set(rows.map((r) => r.job_ref));
}

/** Бали людини за ролями: для причини «Your Engineer score is 72». Кілька рядків за ключем (user_id, role). */
async function userScores(db: Db, userId: string): Promise<FitContext["scores"]> {
  const rows = await db.query<{ role: string; score: number | null }>("SELECT role, score FROM scores WHERE user_id = ?", [userId]);
  const out: Partial<Record<RoleKey, number | null>> = {};
  for (const r of rows) if (isRoleKey(r.role)) out[r.role] = r.score;
  return out;
}

/** Завислі 'pending' старші за STALE_PENDING_MINUTES → 'failed'. Безпечно повторювати. */
export async function sweepStale(db: Db): Promise<void> {
  const age = `-${STALE_PENDING_MINUTES} minutes`;
  await db.batch([
    { sql: "UPDATE sent SET status = 'failed' WHERE status = 'pending' AND digest_id IN " +
        "(SELECT id FROM digest_runs WHERE status = 'pending' AND created_at < datetime('now', ?))", params: [age] },
    { sql: "UPDATE digest_runs SET status = 'failed', error = ?, finished_at = datetime('now') " +
        "WHERE status = 'pending' AND created_at < datetime('now', ?)", params: [INTERRUPTED, age] },
  ], { idempotent: true });
}

// ---------------- прогін ----------------

export interface DigestDeps {
  /** Наша база. null лише для сухого прогону з вигаданим профілем без CF_D1_DATABASE_ID. */
  db: Db | null;
  jobs: JobsDb;
  env: EngineEnv;
  now?: () => Date;
  log?: (line: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  newId?: () => string;
}

export interface DigestOptions {
  /** Нічого не писати й не слати, лише показати вибір. */
  dryRun?: boolean;
  /** Одна людина незалежно від години (лише з dryRun). */
  userId?: string;
  /** Вигаданий профіль замість людей з бази (лише з dryRun). */
  profile?: DigestProfile;
  /** Показати тижневий підсумок порожніх днів у цьому прогоні (типово лише в понеділок о WEEKLY_SUMMARY_HOUR_UTC). */
  weeklySummary?: boolean;
}

/** Тижневий підсумок порожніх днів: понеділок (UTC), година, на яку припадає таймер :05. */
export const WEEKLY_SUMMARY_WEEKDAY_UTC = 1;
export const WEEKLY_SUMMARY_HOUR_UTC = 6;
export const WEEKLY_SUMMARY_DAYS = 7;

/** Загальний запас очікування Telegram 429 на весь прогін, мс; решта людей ідуть у наступний прогін. */
export const MAX_TOTAL_RETRY_WAIT_MS = 240_000;

export interface DryRunEntry {
  who: string;
  local: string;
  plan: string;
  picks: DigestPick[];
}

export interface DigestSummary {
  /** Людей з роллю й балом (після паузи). */
  eligible: number;
  /** Чия година зараз. */
  due: number;
  /** Уже мали добірку на цю дату. */
  already: number;
  /** Без каналу доставки (напр. Telegram без токена): нічого не записано. */
  skipped: number;
  empty: number;
  sent: number;
  failed: number;
  /** Telegram сказав «недосяжний», а пошти немає: позначено, не рахується збоєм. */
  unreachable: number;
  /** Невдалі сьогоднішні прогони, які цього разу пробували вдруге (відновний збій: 429, 5xx). */
  retried: number;
  /** Людей з невпізнаним users.timezone (рахувались за UTC); id людей у журналі рядком WARN. */
  tzFallback: number;
  /** Тижневий підсумок порожніх днів (лише в години підсумку, див. WEEKLY_SUMMARY_*); інакше null. */
  weeklyEmpty: WeeklyEmptyEntry[] | null;
  pool: PoolStats | null;
  companyJobs: number;
  dry: DryRunEntry[];
}

export interface WeeklyEmptyEntry { userId: string; emptyDays: number }

const who = (id: string) => id.slice(0, 8);

/**
 * Вибір → те, що бачить людина. Оцінка дошки (estimates) лише підписом поруч, коли вилки роботодавця
 * немає: сам вибір її не бачив (DigestJob її не має).
 */
export function deliveryJobs(
  picks: readonly DigestPick[], estimates: ReadonlyMap<string, SalaryEstimate> = new Map(),
  profiles: ReadonlyMap<string, CompanyProfile> = new Map(), now: Date = new Date(),
): DeliveryJob[] {
  return picks.map((p, i) => {
    // Про компанію, її сайт і токен лише для вакансій зі сканування: у вакансії компанії є своя сторінка на сайті.
    const known = p.job.source === "nextrole" ? profiles.get(p.job.companyKey) ?? null : null;
    return {
    position: i + 1, title: p.job.title, company: p.job.company, location: p.job.location,
    salary: formatSalary(p.job.salary), why: p.why, url: p.job.url,
    salaryEstimate: formatSalary(p.job.salary) ? null : estimateText(estimates.get(p.job.ref)),
    postedBy: p.job.source === "company" ? p.job.company : null, source: p.job.source, jobId: p.job.id,
    about: known?.about ?? null,
    companyDomain: known?.domain ?? null,
    // Лише свіжі ціни (не старші за TOKEN_STALE_DAYS): інакше рядка немає.
    token: tokenChip(known?.token, now)?.text ?? null,
    };
  });
}

/** Що бачить людина поруч із вибором: оцінки дошки, профілі компаній; checked рахується на людину (countMatches). */
export interface DeliveryExtras {
  estimates: ReadonlyMap<string, SalaryEstimate>;
  profiles: ReadonlyMap<string, CompanyProfile>;
  checked: number;
}

type Planned = { row: DigestUserRow | null; profile: DigestProfile; clock: LocalClock; plan: ChannelPlan };

export async function runDigestDue(deps: DigestDeps, opts: DigestOptions = {}): Promise<DigestSummary> {
  const log = deps.log ?? ((l: string) => console.log(l));
  const now = (deps.now ?? (() => new Date()))();
  const newId = deps.newId ?? (() => `dg_${randomUUID()}`);
  const dry = !!opts.dryRun;
  if ((opts.userId || opts.profile) && !dry) throw new Error("--user and --profile work only with --dry-run");
  const { db } = deps;
  if (!db && !opts.profile) throw new Error("digest: database is required");
  const summary: DigestSummary = {
    eligible: 0, due: 0, already: 0, skipped: 0, empty: 0, sent: 0, failed: 0, unreachable: 0, retried: 0, tzFallback: 0,
    weeklyEmpty: null, pool: null, companyJobs: 0, dry: [],
  };

  if (db && !dry) await sweepStale(db);

  // 1. Кому пора.
  let planned: Planned[] = [];
  /** user id → id невдалого прогону цієї дати, який пробуємо вдруге (той самий digest_id: сайт відкине дубль листа). */
  const retryOf = new Map<string, string>();
  if (opts.profile) {
    planned = [{ row: null, profile: opts.profile, clock: localClock(now, "UTC"), plan: { primary: "email", emailFallback: false } }];
    summary.eligible = summary.due = 1;
  } else {
    const rows = await loadDigestUsers(db!, log, opts.userId);
    summary.eligible = rows.length;
    const due = rows
      .map((row) => ({ row, clock: localClock(now, row.timezone) }))
      .filter(({ row, clock }) => opts.userId || isDueHour(clock.hour, row.digest_hour));
    summary.due = due.length;
    // Невпізнаний пояс мовчки ставав UTC: лишаємо UTC, але рахуємо всіх (не лише тих, кому пора) і пишемо WARN.
    const badTz = rows.filter((row) => !localClock(now, row.timezone).tzValid);
    summary.tzFallback = badTz.length;
    if (badTz.length) {
      log(`digest: WARN ${badTz.length} user(s) with an unrecognised timezone are counted in UTC: ` +
        badTz.map((r) => `${who(r.id)} "${(r.timezone ?? "").slice(0, 40)}"`).join(", "));
    }
    const done = due.length && !dry ? await existingRuns(db!, due.map((d) => ({ id: d.row.id, date: d.clock.date }))) : new Map<string, ExistingRun>();
    for (const { row, clock } of due) {
      const prev = done.get(`${row.id}|${clock.date}`);
      if (prev) {
        // Невдалий сьогодні прогін з відновним збоєм пробуємо знову в межах вікна isDueHour (година людини і наступна).
        if (!canRetryRun(prev, now)) { summary.already++; continue; }
        retryOf.set(row.id, prev.id);
      }
      const plan = planChannel(deliveryUser(row), deps.env);
      if ("skip" in plan && !dry) {
        summary.skipped++;
        log(`digest: user ${who(row.id)} skipped: ${plan.skip}`);
        continue;
      }
      planned.push({ row, profile: profileOf(row), clock, plan });
    }
  }
  if (planned.length === 0) {
    log(`digest-due: nobody due (eligible ${summary.eligible}, due ${summary.due}, already ${summary.already}, skipped ${summary.skipped}, tz-fallback ${summary.tzFallback})`);
    if (db && !dry) await weeklyEmptyIfDue(db, now, log, summary, opts.weeklySummary);
    return summary;
  }

  // 2. Пул: один раз на прогін.
  const crawl = await loadCrawlPool(deps.jobs, now);
  summary.pool = crawl.stats;
  const company = db ? await loadCompanyPool(db, log, siteUrlOf(deps.env) ?? DEFAULT_SITE_URL) : [];
  summary.companyJobs = company.length;
  const pool = { crawl: crawl.jobs, company };
  const extras: DeliveryExtras = {
    estimates: crawl.estimates, profiles: await loadCompanyProfiles(deps.jobs, log), checked: 0,
  };
  log(`digest: pool ${crawl.stats.kept} jobs, ${crawl.stats.older} of them posted over 30 d ago (fetched ${crawl.stats.fetched}, dropped tag ${crawl.stats.dropped.tag} ` +
    `company ${crawl.stats.dropped.company} title ${crawl.stats.dropped.title}; rows_read ${crawl.stats.rowsRead ?? "n/a"}, ` +
    `D1 ${crawl.stats.d1Ms === null ? "n/a" : `${Math.round(crawl.stats.d1Ms)} ms`}, wall ${crawl.stats.wallMs} ms); company jobs ${company.length}`);

  // Запас очікування Telegram 429 один на весь прогін: сервіс не може вийти за TimeoutStartSec.
  const waitBudget = { remainingMs: MAX_TOTAL_RETRY_WAIT_MS };

  // 3. Кожна людина окремо: збій однієї не зупиняє інших.
  for (const p of planned) {
    const label = p.row ? `user ${who(p.row.id)}` : "profile";
    try {
      const exclude = p.row && db ? await sentRefs(db, p.row.id) : new Set<string>();
      // Пояснення словами людини (fit.ts): сам вибір від цього не залежить.
      const fit: FitContext = { words: p.row?.target_text ?? null, scores: p.row && db ? await userScores(db, p.row.id) : {} };
      // Рівень картки людини для м'якого ранжування за сенйорністю (match.ts personLevel).
      const profile: DigestProfile = { ...p.profile, scoreLevel: levelOfScores(fit.scores) };
      const picks = selectJobs(pool, profile, { now, exclude }).map((pk) => ({ ...pk, why: fitLine(pk, profile, fit, now) }));
      if (dry) {
        summary.dry.push({
          who: label, local: `${p.clock.date} ${String(p.clock.hour).padStart(2, "0")}h ${p.clock.tz}`,
          plan: "skip" in p.plan ? `skip: ${p.plan.skip}` : `${p.plan.primary}${p.plan.emailFallback ? " (email fallback)" : ""}`,
          picks,
        });
        continue;
      }
      const row = p.row!;
      const plan = p.plan as Exclude<ChannelPlan, { skip: string }>;
      const retryId = retryOf.get(row.id);
      // Скільки вакансій підійшло саме цій людині (а не розмір пулу до фільтрів).
      const mine = { ...extras, checked: countMatches(pool, profile, { now, exclude }) };
      const outcome = await buildAndDeliver(db!, deps, row, p.clock.date, picks, plan, retryId ?? newId(), log, mine, waitBudget, !!retryId);
      if (retryId && typeof outcome === "object") summary.retried++;
      if (outcome === "empty") summary.empty++;
      else if (outcome === "already") summary.already++;
      else if (outcome.status === "sent") summary.sent++;
      else if (outcome.unreachable && outcome.channel === "telegram") summary.unreachable++;
      else summary.failed++;
    } catch (e) {
      summary.failed++;
      log(`digest: ${label} error: ${shortError(e, 200)}`);
    }
  }
  log(`digest-due: eligible ${summary.eligible}, due ${summary.due}, sent ${summary.sent}, failed ${summary.failed}, ` +
    `unreachable ${summary.unreachable}, retried ${summary.retried}, tz-fallback ${summary.tzFallback}, ` +
    `empty ${summary.empty}, skipped ${summary.skipped}, already ${summary.already}${dry ? " (dry run)" : ""}`);
  if (db && !dry) await weeklyEmptyIfDue(db, now, log, summary, opts.weeklySummary);
  return summary;
}

function deliveryUser(row: DigestUserRow): DeliveryUser {
  return { id: row.id, channel: row.channel, email: row.email, telegramId: row.telegram_id, telegramUnreachable: !!row.telegram_unreachable_at };
}

async function buildAndDeliver(
  db: Db, deps: DigestDeps, row: DigestUserRow, localDate: string, picks: DigestPick[],
  plan: { primary: "telegram" | "email"; emailFallback: boolean }, digestId: string, log: (l: string) => void,
  extras: DeliveryExtras = { estimates: new Map(), profiles: new Map(), checked: 0 },
  waitBudget?: { remainingMs: number }, isRetry = false,
): Promise<DeliveryOutcome | "empty" | "already"> {
  if (picks.length === 0) {
    // Запис, щоб наступна година (запас isDueHour) не шукала вдруге того самого дня.
    await db.run("INSERT OR IGNORE INTO digest_runs (id, user_id, local_date, status, jobs, error, finished_at) " +
      "VALUES (?, ?, ?, 'empty', 0, 'no matching jobs', datetime('now'))", [digestId, row.id, localDate], { idempotent: true });
    log(`digest: user ${who(row.id)} ${localDate}: no matching jobs`);
    return "empty";
  }
  const insert: D1Statement[] = [
    // Повтор невдалого прогону: старі рядки прогону й його 'failed' sent прибираємо в тій самій транзакції.
    // Якщо інша копія вже забрала прогін ('pending'), DELETE нічого не зачепить, а вставка впреться в PRIMARY KEY.
    ...(isRetry ? [
      { sql: "DELETE FROM sent WHERE digest_id = ? AND status = 'failed'", params: [digestId] },
      { sql: "DELETE FROM digest_runs WHERE id = ? AND status = 'failed'", params: [digestId] },
    ] : []),
    // Вакансії з невдалих доставок (інших днів) знову вільні: старий 'failed' рядок не має блокувати вставку (UNIQUE user_id, job_ref).
    { sql: `DELETE FROM sent WHERE user_id = ? AND status = 'failed' AND job_ref IN (${picks.map(() => "?").join(", ")})`,
      params: [row.id, ...picks.map((p) => p.job.ref)] },
    { sql: "INSERT INTO digest_runs (id, user_id, local_date, status, jobs, channel) VALUES (?, ?, ?, 'pending', ?, ?)",
      params: [digestId, row.id, localDate, picks.length, plan.primary] },
    ...picks.map((p, i) => ({
      sql: "INSERT INTO sent (user_id, job_ref, source, digest_id, position, status, channel, why) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)",
      params: [row.id, p.job.ref, p.job.source, digestId, i + 1, plan.primary, p.why],
    })),
  ];
  try {
    await db.batch(insert);
  } catch (e) {
    // Інша копія прогону встигла першою (UNIQUE): вона й шле.
    if (e instanceof Error && /UNIQUE constraint failed/i.test(e.message)) {
      log(`digest: user ${who(row.id)} ${localDate}: already claimed by another run`);
      return "already";
    }
    throw e;
  }

  const message: DigestMessage = {
    digestId, userId: row.id, localDate, jobs: deliveryJobs(picks, extras.estimates, extras.profiles, (deps.now ?? (() => new Date()))()), checked: extras.checked,
  };
  const outcome = await deliverDigest(deliveryUser(row), message, plan,
    // Годинник, а не мить початку прогону: `ts` листа ставиться під час відправки. Прогін
    // з паузами Telegram (429) може тривати довше за 5 хвилин, і сайт відкинув би старий ts.
    { env: deps.env, fetchImpl: deps.fetchImpl, sleep: deps.sleep, now: deps.now, log, ...(waitBudget ? { waitBudget } : {}) });
  const status = outcome.status;
  const channel = outcome.channel;
  const detail = outcome.status === "sent" ? outcome.note : outcome.error;
  await db.batch([
    { sql: "UPDATE sent SET status = ?, channel = ?, sent_at = CASE WHEN ? = 'sent' THEN datetime('now') END WHERE digest_id = ?",
      params: [status, channel, status, digestId] },
    { sql: "UPDATE digest_runs SET status = ?, channel = ?, error = ?, finished_at = datetime('now') WHERE id = ?",
      params: [status, channel, detail, digestId] },
  ], { idempotent: true });
  if (outcome.unreachable) {
    // Наступні дні: лист одразу або пропуск (planChannel). Знімає позначку повідомлення людини боту.
    await db.run("UPDATE users SET telegram_unreachable_at = datetime('now') WHERE id = ?", [row.id], { idempotent: true })
      .catch((e: unknown) => log(`digest: telegram_unreachable_at not set: ${shortError(e, 120)}`));
  }
  if (status === "sent") {
    const shown = picks.filter((p) => p.job.source === "company");
    // Лічильник для компанії (специфікація CRM 5.6). Приріст не ідемпотентний: окремо й без повтору.
    if (shown.length) {
      await db.batch(shown.map((p) => ({ sql: "UPDATE company_jobs SET digest_shown = digest_shown + 1 WHERE id = ?", params: [p.job.id] })))
        .catch((e: unknown) => log(`digest: digest_shown not updated: ${shortError(e, 120)}`));
    }
  }
  log(`digest: user ${who(row.id)} ${localDate}: ${status} via ${channel ?? "none"}, ${picks.length} jobs` +
    `${detail ? ` (${detail})` : ""}`);
  return outcome;
}

/** Текст сухого прогону для командного рядка. */
export function formatDryRun(summary: DigestSummary): string[] {
  const lines: string[] = [];
  for (const d of summary.dry) {
    lines.push(`${d.who} (${d.local}, ${d.plan}): ${d.picks.length} jobs`);
    d.picks.forEach((p, i) => {
      const j: DigestJob = p.job;
      lines.push(`  ${i + 1}. ${j.title} | ${j.company} | ${j.location ?? "n/a"}${formatSalary(j.salary) ? ` | ${formatSalary(j.salary)}` : ""} | ${j.ref}`);
      lines.push(`     ${p.why}`);
      lines.push(`     ${j.url}`);
    });
  }
  return lines;
}

// ---------------- тижневий підсумок порожніх днів ----------------

/** Скільки днів за останні WEEKLY_SUMMARY_DAYS людина не мала жодної вакансії (digest_runs 'empty'). Лише ті, у кого хоч один. */
export async function weeklyEmptyDays(db: Db, now: Date): Promise<WeeklyEmptyEntry[]> {
  const from = new Date(now.getTime() - WEEKLY_SUMMARY_DAYS * 86_400_000).toISOString().slice(0, 10);
  const rows = await db.query<{ user_id: string; n: number }>(
    "SELECT user_id, COUNT(*) AS n FROM digest_runs WHERE status = 'empty' AND local_date >= ? GROUP BY user_id ORDER BY n DESC, user_id", [from]);
  return rows.map((r) => ({ userId: r.user_id, emptyDays: r.n }));
}

/** Раз на тиждень (понеділок, WEEKLY_SUMMARY_HOUR_UTC) або за `force`: у журнал і в підсумок. Помилка підсумку прогін не валить. */
async function weeklyEmptyIfDue(db: Db, now: Date, log: (l: string) => void, summary: DigestSummary, force?: boolean): Promise<void> {
  const time = now.getUTCDay() === WEEKLY_SUMMARY_WEEKDAY_UTC && now.getUTCHours() === WEEKLY_SUMMARY_HOUR_UTC;
  if (!force && !time) return;
  try {
    const list = await weeklyEmptyDays(db, now);
    summary.weeklyEmpty = list;
    log(`digest-weekly: empty days in the last ${WEEKLY_SUMMARY_DAYS} d for ${list.length} user(s)` +
      `${list.length ? `: ${list.map((e) => `${who(e.userId)} ${e.emptyDays}`).join(", ")}` : ""}`);
  } catch (e) {
    log(`digest-weekly: not available: ${shortError(e, 120)}`);
  }
}
