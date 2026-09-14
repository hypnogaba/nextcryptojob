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
import { type DigestJob, type DigestPick, type DigestProfile, formatSalary, selectJobs } from "./match.js";
import { isRoleKey, parseRoles } from "./roles.js";

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
}

const USER_COLUMNS = "u.id, u.roles, u.remote_mode, u.city, u.salary_min, u.salary_currency, u.digest_hour, " +
  "u.timezone, u.channel, u.email, u.telegram_id, u.target_text";
/** Своя роль словами (0020_role_text). Без міграції запит іде без неї, і збіг за словами поки не діє. */
const ROLE_TEXT_COLUMN = ", u.role_text";

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
  let paused = " AND COALESCE(u.digest_paused, 0) = 0";
  let demo = " AND u.is_demo = 0";
  // Кожна відсутня колонка знімається раз: не більше чотирьох спроб.
  for (;;) {
    try {
      return await db.query<DigestUserRow>(`${base(extra)}${paused}${demo}${byId}`, params);
    } catch (e) {
      if (extra && missing(e, "role_text")) {
        log("digest: users.role_text missing (migration 0020 not applied), own-words matching is off");
        extra = "";
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

export function profileOf(u: Pick<DigestUserRow, "roles" | "remote_mode" | "city" | "salary_min" | "salary_currency" | "role_text">): DigestProfile {
  return {
    roles: parseRoles(u.roles), remoteMode: u.remote_mode, city: u.city?.trim() || null,
    salaryMin: u.salary_min, salaryCurrency: u.salary_currency, roleText: u.role_text?.trim() || null,
  };
}

/** Прогони, що вже є на дати людей. IN по user_id і межа дати йдуть індексом UNIQUE(user_id, local_date). */
async function existingRuns(db: Db, due: ReadonlyArray<{ id: string; date: string }>): Promise<Set<string>> {
  const out = new Set<string>();
  const minDate = due.reduce((m, d) => (d.date < m ? d.date : m), "9999-12-31");
  for (let i = 0; i < due.length; i += 90) {
    const chunk = due.slice(i, i + 90);
    const rows = await db.query<{ user_id: string; local_date: string }>(
      `SELECT user_id, local_date FROM digest_runs WHERE user_id IN (${chunk.map(() => "?").join(", ")}) AND local_date >= ?`,
      [...chunk.map((d) => d.id), minDate]);
    for (const r of rows) out.add(`${r.user_id}|${r.local_date}`);
  }
  return out;
}

async function sentRefs(db: Db, userId: string): Promise<Set<string>> {
  // Усі, без межі в часі: UNIQUE(user_id, job_ref) не дасть вставити старий рядок удруге.
  const rows = await db.query<{ job_ref: string }>("SELECT job_ref FROM sent WHERE user_id = ?", [userId]);
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
}

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
  pool: PoolStats | null;
  companyJobs: number;
  dry: DryRunEntry[];
}

const who = (id: string) => id.slice(0, 8);

/**
 * Вибір → те, що бачить людина. Оцінка дошки (estimates) лише підписом поруч, коли вилки роботодавця
 * немає: сам вибір її не бачив (DigestJob її не має).
 */
export function deliveryJobs(
  picks: readonly DigestPick[], estimates: ReadonlyMap<string, SalaryEstimate> = new Map(),
  profiles: ReadonlyMap<string, CompanyProfile> = new Map(),
): DeliveryJob[] {
  return picks.map((p, i) => ({
    position: i + 1, title: p.job.title, company: p.job.company, location: p.job.location,
    salary: formatSalary(p.job.salary), why: p.why, url: p.job.url,
    salaryEstimate: formatSalary(p.job.salary) ? null : estimateText(estimates.get(p.job.ref)),
    postedBy: p.job.source === "company" ? p.job.company : null, source: p.job.source,
    // Про компанію лише для вакансій зі сканування: у вакансії компанії є своя сторінка на сайті.
    about: p.job.source === "nextrole" ? (profiles.get(p.job.companyKey)?.about ?? null) : null,
  }));
}

/** Що бачить людина поруч із вибором: оцінки дошки, профілі компаній, скільки вакансій переглянуто. */
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
    eligible: 0, due: 0, already: 0, skipped: 0, empty: 0, sent: 0, failed: 0, pool: null, companyJobs: 0, dry: [],
  };

  if (db && !dry) await sweepStale(db);

  // 1. Кому пора.
  let planned: Planned[] = [];
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
    for (const { row, clock } of due) {
      if (!clock.tzValid) log(`digest: user ${who(row.id)} timezone not recognised, using UTC`);
    }
    const done = due.length && !dry ? await existingRuns(db!, due.map((d) => ({ id: d.row.id, date: d.clock.date }))) : new Set<string>();
    for (const { row, clock } of due) {
      if (done.has(`${row.id}|${clock.date}`)) { summary.already++; continue; }
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
    log(`digest-due: nobody due (eligible ${summary.eligible}, due ${summary.due}, already ${summary.already}, skipped ${summary.skipped})`);
    return summary;
  }

  // 2. Пул: один раз на прогін.
  const crawl = await loadCrawlPool(deps.jobs, now);
  summary.pool = crawl.stats;
  const company = db ? await loadCompanyPool(db, log, siteUrlOf(deps.env) ?? DEFAULT_SITE_URL) : [];
  summary.companyJobs = company.length;
  const pool = { crawl: crawl.jobs, company };
  const extras: DeliveryExtras = {
    estimates: crawl.estimates, profiles: await loadCompanyProfiles(deps.jobs, log), checked: crawl.jobs.length + company.length,
  };
  log(`digest: pool ${crawl.stats.kept} jobs, ${crawl.stats.older} of them posted over 30 d ago (fetched ${crawl.stats.fetched}, dropped tag ${crawl.stats.dropped.tag} ` +
    `company ${crawl.stats.dropped.company} title ${crawl.stats.dropped.title}; rows_read ${crawl.stats.rowsRead ?? "n/a"}, ` +
    `D1 ${crawl.stats.d1Ms === null ? "n/a" : `${Math.round(crawl.stats.d1Ms)} ms`}, wall ${crawl.stats.wallMs} ms); company jobs ${company.length}`);

  // 3. Кожна людина окремо: збій однієї не зупиняє інших.
  for (const p of planned) {
    const label = p.row ? `user ${who(p.row.id)}` : "profile";
    try {
      const exclude = p.row && db ? await sentRefs(db, p.row.id) : new Set<string>();
      // Пояснення словами людини (fit.ts): сам вибір від цього не залежить.
      const fit: FitContext = { words: p.row?.target_text ?? null, scores: p.row && db ? await userScores(db, p.row.id) : {} };
      const picks = selectJobs(pool, p.profile, { now, exclude }).map((pk) => ({ ...pk, why: fitLine(pk, p.profile, fit, now) }));
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
      const outcome = await buildAndDeliver(db!, deps, row, p.clock.date, picks, plan, newId(), log, extras);
      if (outcome === "empty") summary.empty++;
      else if (outcome === "already") summary.already++;
      else if (outcome.status === "sent") summary.sent++;
      else summary.failed++;
    } catch (e) {
      summary.failed++;
      log(`digest: ${label} error: ${shortError(e, 200)}`);
    }
  }
  log(`digest-due: eligible ${summary.eligible}, due ${summary.due}, sent ${summary.sent}, failed ${summary.failed}, ` +
    `empty ${summary.empty}, skipped ${summary.skipped}, already ${summary.already}${dry ? " (dry run)" : ""}`);
  return summary;
}

function deliveryUser(row: DigestUserRow): DeliveryUser {
  return { id: row.id, channel: row.channel, email: row.email, telegramId: row.telegram_id };
}

async function buildAndDeliver(
  db: Db, deps: DigestDeps, row: DigestUserRow, localDate: string, picks: DigestPick[],
  plan: { primary: "telegram" | "email"; emailFallback: boolean }, digestId: string, log: (l: string) => void,
  extras: DeliveryExtras = { estimates: new Map(), profiles: new Map(), checked: 0 },
): Promise<DeliveryOutcome | "empty" | "already"> {
  if (picks.length === 0) {
    // Запис, щоб наступна година (запас isDueHour) не шукала вдруге того самого дня.
    await db.run("INSERT OR IGNORE INTO digest_runs (id, user_id, local_date, status, jobs, error, finished_at) " +
      "VALUES (?, ?, ?, 'empty', 0, 'no matching jobs', datetime('now'))", [digestId, row.id, localDate], { idempotent: true });
    log(`digest: user ${who(row.id)} ${localDate}: no matching jobs`);
    return "empty";
  }
  const insert: D1Statement[] = [
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
    digestId, userId: row.id, localDate, jobs: deliveryJobs(picks, extras.estimates, extras.profiles), checked: extras.checked,
  };
  const outcome = await deliverDigest(deliveryUser(row), message, plan,
    // Годинник, а не мить початку прогону: `ts` листа ставиться під час відправки. Прогін
    // з паузами Telegram (429) може тривати довше за 5 хвилин, і сайт відкинув би старий ts.
    { env: deps.env, fetchImpl: deps.fetchImpl, sleep: deps.sleep, now: deps.now, log });
  const status = outcome.status;
  const channel = outcome.channel;
  const detail = outcome.status === "sent" ? outcome.note : outcome.error;
  await db.batch([
    { sql: "UPDATE sent SET status = ?, channel = ?, sent_at = CASE WHEN ? = 'sent' THEN datetime('now') END WHERE digest_id = ?",
      params: [status, channel, status, digestId] },
    { sql: "UPDATE digest_runs SET status = ?, channel = ?, error = ?, finished_at = datetime('now') WHERE id = ?",
      params: [status, channel, detail, digestId] },
  ], { idempotent: true });
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
