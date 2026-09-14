import { parseDbTime, SCAN_TIME_UTC, type JobSourcesReport } from "@/lib/admin/job-sources";
import { CRONS, SCHEDULE } from "@/lib/cron";
import { sqlTime, startOfUtcDay } from "@/lib/time";

/**
 * Головна адмінки (/admin): усе, що треба бачити щодня, одним пакетом D1.
 *
 * Сім інструкцій в одному DB.batch (OVERVIEW_STATEMENTS), кожна агрегує свою частину
 * (COUNT, SUM, GROUP BY), без запитів на рядок. Багаторядкові частини (версії формули,
 * статуси знайомств, причини збоїв) згорнуто в JSON усередині тієї ж інструкції
 * (json_group_array, json_group_object), тож на блок припадає один рядок відповіді.
 * Вакансії беремо з кешованого звіту /admin/sources (lib/admin/job-sources.ts), а не
 * рахуємо тут: це повний прохід по jobs_cache в базі вакансій.
 *
 * Що тут не рахується, бо в базі немає історії: переходи "Apply" за 7 днів (company_jobs
 * тримає лише загальний лічильник), час останнього скану поза звітом джерел.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Скільки інструкцій іде в пакет головної (тест звіряє, що більше не стало). */
export const OVERVIEW_STATEMENTS = 7;

/** Запуск задачі cron запізнився, якщо останній старший за це. */
export const CRON_LATE_AFTER_MS: Record<string, number> = {
  [CRONS.every5Minutes]: 15 * MIN,
  [CRONS.hourly]: 90 * MIN,
  [CRONS.daily]: 26 * HOUR,
};

/** Черга балу: найстаріша задача чекає довше за це, рушій її не бере. */
export const QUEUE_WAIT_ALERT_MS = HOUR;
/** Рушій без жодного запису стільки часу, а в черзі є задачі. */
export const ENGINE_IDLE_ALERT_MS = DAY;
/** Прогін добірки йде щогодини (таймер engine о :05); довше без жодного прогону = таймер стоїть. */
export const DIGEST_IDLE_ALERT_MS = 26 * HOUR;
/** 'pending' довше за це вже не доставиться (engine/src/digest/schedule.ts STALE_PENDING_MINUTES). */
export const DIGEST_STUCK_MINUTES = 30;
/** Хвилина години, коли таймер engine запускає добірку (deploy/nextcryptojob-digest.timer). */
export const DIGEST_RUN_MINUTE = 5;

export type DigestDay = {
  /** YYYY-MM-DD, UTC. */
  day: string;
  runs: number;
  sent: number;
  failed: number;
  empty: number;
  pending: number;
  telegram: number;
  email: number;
  /** Вакансій у доставлених добірках. */
  jobsSent: number;
};

export type CronJobStatus = {
  job: string;
  cron: string;
  lastAt: number | null;
  ok: boolean | null;
  ms: number | null;
  error: string | null;
  counts: Record<string, number> | null;
  lastOkAt: number | null;
  failed24h: number;
  /** Останній запуск старший за CRON_LATE_AFTER_MS (або його немає, хоча журнал ведеться довше). */
  late: boolean;
};

export type Overview = {
  now: number;
  candidates: {
    total: number;
    today: number;
    d7: number;
    d30: number;
    emailOnly: number;
    telegramOnly: number;
    both: number;
    briefStarted: number;
    briefDone: number;
    xVerified: number;
    wallets: number;
    cards: number;
    visible: number;
    channelTelegram: number;
    channelEmail: number;
    paused: number;
  };
  scores: {
    usersScored: number;
    queued: number;
    running: number;
    oldestQueuedAt: number | null;
    failed24h: number;
    done24h: number;
    /** Найсвіжіший запис рушія: бал, завершена задача або задача, яку він узяв. */
    lastEngineAt: number | null;
    versions: { version: string; users: number; published: boolean }[];
    quality: { version: string; nearPct: number; exactPct: number; people: number; passed: boolean; runAt: number | null } | null;
  };
  digests: {
    days: DigestDay[];
    newestRunAt: number | null;
    stuckPending: number;
    failureReasons: { reason: string; n: number }[];
    /** Кому добірка може піти: роль є, бал є, без паузи (як loadDigestUsers в engine). */
    eligible: number;
    nextRunAt: number;
    /** З них у наступному прогоні: година людини = digest_hour. */
    dueNext: number;
  };
  companies: {
    trial: number;
    subscribed: number;
    payPerRequest: number;
    pendingReview: number;
    suspended: number;
    closed: number;
    agenciesPending: number;
    members: number;
    invitesOpen: number;
    searches7d: number;
    views7d: number;
    intros7d: number;
    intros: Record<string, number>;
    openJobs: number;
    liveJobs: number;
    applyClicksTotal: number;
    xQueue: number;
  };
  payments: {
    x402: Record<string, number>;
    settledCents: number;
    noResultWaiting: number;
    stale: number;
    subscriptions: { provider: string; status: string; n: number }[];
  };
  cron: { available: boolean; error: string | null; firstRecordedAt: number | null; jobs: CronJobStatus[] };
  /** Скільки рядків прочитала D1 (meta.rows_read), якщо база це повідомляє. */
  rowsRead: number | null;
  statements: number;
};

type Row = Record<string, unknown>;

const num = (v: unknown): number => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const time = (v: unknown): number | null => (typeof v === "string" ? parseDbTime(v) : null);

function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return (JSON.parse(v) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Задачі cron у порядку розкладу: назва й тригер. */
export function cronJobs(): { job: string; cron: string }[] {
  return Object.entries(SCHEDULE).flatMap(([cron, jobs]) => jobs.map((j) => ({ job: j.name, cron })));
}

// ---------------- інструкції ----------------

type Times = { today: string; d7: string; d30: string; h24: string; digestFrom: string; stuck: string; stale5: string };

function times(now: Date): Times {
  const t = now.getTime();
  const today = startOfUtcDay(now);
  return {
    today: sqlTime(today),
    d7: sqlTime(new Date(t - 7 * DAY)),
    d30: sqlTime(new Date(t - 30 * DAY)),
    h24: sqlTime(new Date(t - DAY)),
    // Сім днів UTC разом із сьогоднішнім.
    digestFrom: sqlTime(new Date(today.getTime() - 6 * DAY)),
    stuck: sqlTime(new Date(t - DIGEST_STUCK_MINUTES * MIN)),
    stale5: sqlTime(new Date(t - 5 * MIN)),
  };
}

/** Кандидати: один прохід по users і три підрахунки по малих індексах. Демо (is_demo, 0020) не рахуємо ніде. */
export const CANDIDATES_SQL = `SELECT
  COUNT(*) AS total,
  COALESCE(SUM(u.created_at >= ?1), 0) AS today,
  COALESCE(SUM(u.created_at >= ?2), 0) AS d7,
  COALESCE(SUM(u.created_at >= ?3), 0) AS d30,
  COALESCE(SUM(u.email IS NOT NULL AND u.telegram_id IS NULL), 0) AS email_only,
  COALESCE(SUM(u.telegram_id IS NOT NULL AND u.email IS NULL), 0) AS telegram_only,
  COALESCE(SUM(u.email IS NOT NULL AND u.telegram_id IS NOT NULL), 0) AS both_methods,
  COALESCE(SUM(u.onboarding_step IS NOT NULL), 0) AS brief_started,
  COALESCE(SUM(u.onboarding_step IN ('x', 'wallets', 'sources', 'done')
    AND EXISTS (SELECT 1 FROM consents c WHERE c.user_id = u.id AND c.kind = 'scoring' AND c.granted = 1)), 0) AS brief_done,
  COALESCE(SUM(u.visible_to_companies = 1), 0) AS visible,
  COALESCE(SUM(u.channel = 'telegram'), 0) AS channel_telegram,
  COALESCE(SUM(u.channel = 'email'), 0) AS channel_email,
  COALESCE(SUM(u.digest_paused = 1), 0) AS paused,
  (SELECT COUNT(DISTINCT user_id) FROM identities WHERE kind = 'x' AND verified_at IS NOT NULL
      AND user_id NOT IN (SELECT id FROM users WHERE is_demo = 1)) AS x_verified,
  (SELECT COUNT(DISTINCT user_id) FROM identities WHERE kind IN ('evm', 'solana')) AS wallets,
  (SELECT COUNT(DISTINCT user_id) FROM cards WHERE revoked_at IS NULL) AS cards
FROM users u WHERE u.is_demo = 0`;

/**
 * Бал і черга. Черга йде індексом (status, queued_at); завершені за добу обмежено ще й
 * queued_at за тиждень, щоб не перебирати всі старі 'done'. Остання активність рушія:
 * найсвіжіше з балу, 50 останніх завершених задач і задач, які він зараз рахує.
 */
export const SCORES_SQL = `SELECT
  (SELECT COUNT(DISTINCT user_id) FROM scores WHERE user_id NOT IN (SELECT id FROM users WHERE is_demo = 1)) AS users_scored,
  (SELECT COUNT(*) FROM score_jobs WHERE status = 'queued') AS queued,
  (SELECT COUNT(*) FROM score_jobs WHERE status = 'running') AS running,
  (SELECT MIN(queued_at) FROM score_jobs WHERE status = 'queued') AS oldest_queued,
  (SELECT COUNT(*) FROM score_jobs WHERE status = 'failed' AND queued_at >= ?1 AND finished_at >= ?2) AS failed_24h,
  (SELECT COUNT(*) FROM score_jobs WHERE status = 'done' AND queued_at >= ?1 AND finished_at >= ?2) AS done_24h,
  (SELECT MAX(finished_at) FROM (SELECT finished_at FROM score_jobs WHERE status IN ('done', 'failed') ORDER BY id DESC LIMIT 50)) AS last_finished,
  (SELECT MAX(started_at) FROM score_jobs WHERE status = 'running') AS last_started,
  (SELECT MAX(computed_at) FROM scores WHERE user_id NOT IN (SELECT id FROM users WHERE is_demo = 1)) AS last_score,
  (SELECT json_group_array(json_array(formula_version, n, published)) FROM (
     SELECT s.formula_version, COUNT(DISTINCT s.user_id) AS n,
            EXISTS (SELECT 1 FROM quality_runs q WHERE q.formula_version = s.formula_version AND q.passed = 1) AS published
       FROM scores s WHERE s.user_id NOT IN (SELECT id FROM users WHERE is_demo = 1)
      GROUP BY s.formula_version ORDER BY n DESC)) AS versions,
  q.formula_version AS q_version, q.near_pct AS q_near, q.exact_pct AS q_exact, q.people AS q_people,
  q.passed AS q_passed, q.run_at AS q_run_at
FROM (SELECT 1) LEFT JOIN (SELECT * FROM quality_runs ORDER BY id DESC LIMIT 1) q ON 1`;

/** Добірки за 7 днів UTC по днях: діапазон індексом idx_digest_runs_created (0019). */
export const DIGEST_DAYS_SQL = `SELECT substr(created_at, 1, 10) AS day,
  COUNT(*) AS runs,
  SUM(status = 'sent') AS sent,
  SUM(status = 'failed') AS failed,
  SUM(status = 'empty') AS empty,
  SUM(status = 'pending') AS pending,
  SUM(status = 'sent' AND channel = 'telegram') AS telegram,
  SUM(status = 'sent' AND channel = 'email') AS email,
  COALESCE(SUM(CASE WHEN status = 'sent' THEN jobs END), 0) AS jobs_sent
FROM digest_runs WHERE created_at >= ?1
GROUP BY day ORDER BY day DESC`;

/**
 * Решта про добірки: найсвіжіший прогін, завислі, п'ять найчастіших причин збою за 7 днів
 * і групи (година, пояс) людей, яким добірка може піти, щоб порахувати наступний прогін.
 * Груп не більше, ніж 24 години на кількість різних поясів.
 */
export const DIGEST_MISC_SQL = `SELECT
  (SELECT MAX(created_at) FROM digest_runs) AS newest_run,
  (SELECT COUNT(*) FROM digest_runs WHERE status = 'pending' AND created_at < ?2) AS stuck,
  (SELECT json_group_array(json_array(reason, n)) FROM (
     SELECT substr(COALESCE(NULLIF(error, ''), 'no reason recorded'), 1, 120) AS reason, COUNT(*) AS n
       FROM digest_runs WHERE created_at >= ?1 AND status = 'failed'
      GROUP BY reason ORDER BY n DESC LIMIT 5)) AS reasons,
  (SELECT json_group_array(json_array(digest_hour, tz, n)) FROM (
     SELECT u.digest_hour, COALESCE(u.timezone, '') AS tz, COUNT(*) AS n FROM users u
      WHERE u.roles <> '[]' AND COALESCE(u.digest_paused, 0) = 0 AND u.is_demo = 0
        AND EXISTS (SELECT 1 FROM scores s WHERE s.user_id = u.id)
      GROUP BY 1, 2)) AS due_groups`;

/**
 * Компанії й CRM. Використання за 7 днів: діапазон індексом idx_usage_created.
 * Демо-компанії (is_demo, 0020) не рахуємо: список їхніх id іде частковим індексом.
 */
const DEMO_COMPANIES = "(SELECT id FROM companies WHERE is_demo = 1)";
export const COMPANIES_SQL = `SELECT
  (SELECT json_group_object(bucket, n) FROM (
     SELECT CASE WHEN c.status <> 'active' THEN c.status
                 WHEN a.access = 'subscription' AND a.latest_status = 'trialing' THEN 'trial'
                 WHEN a.access = 'subscription' THEN 'subscribed'
                 ELSE 'pay_per_request' END AS bucket, COUNT(*) AS n
       FROM companies c JOIN company_access a ON a.company_id = c.id WHERE c.is_demo = 0 GROUP BY bucket)) AS buckets,
  (SELECT COUNT(*) FROM agency_applications WHERE status IN ('pending', 'needs_info')) AS agencies_pending,
  (SELECT COUNT(*) FROM company_members WHERE user_id IS NOT NULL AND company_id NOT IN ${DEMO_COMPANIES}) AS members,
  (SELECT COUNT(*) FROM company_members WHERE user_id IS NULL AND invited_at >= ?1) AS invites_open,
  (SELECT json_object('searches', COALESCE(SUM(action = 'search_candidates'), 0),
                      'views', COALESCE(SUM(action = 'get_candidate'), 0))
     FROM usage_events WHERE created_at >= ?1 AND status BETWEEN 200 AND 299
      AND (company_id IS NULL OR company_id NOT IN ${DEMO_COMPANIES})) AS usage,
  (SELECT COUNT(*) FROM intros WHERE created_at >= ?1 AND company_id NOT IN ${DEMO_COMPANIES}) AS intros_7d,
  (SELECT json_group_object(status, n) FROM (SELECT status, COUNT(*) AS n FROM intros
     WHERE company_id NOT IN ${DEMO_COMPANIES} GROUP BY status)) AS intros,
  (SELECT COUNT(*) FROM company_jobs WHERE status = 'open' AND company_id NOT IN ${DEMO_COMPANIES}) AS open_jobs,
  (SELECT COUNT(*) FROM company_jobs_live) AS live_jobs,
  (SELECT COALESCE(SUM(apply_clicks), 0) FROM company_jobs) AS apply_clicks,
  (SELECT COUNT(*) FROM company_jobs WHERE x_post_state = 'queued' AND company_id NOT IN ${DEMO_COMPANIES}) AS x_queue`;

/** Оплати: x402 за статусами, «Paid without result», завислі (як findStalePayments), Stripe. */
export const PAYMENTS_SQL = `SELECT
  (SELECT json_group_object(status, n) FROM (SELECT status, COUNT(*) AS n FROM x402_payments GROUP BY status)) AS x402,
  (SELECT COALESCE(SUM(amount_usd_cents), 0) FROM x402_payments WHERE status = 'settled') AS settled_cents,
  (SELECT COUNT(*) FROM x402_payments WHERE no_result_at IS NOT NULL AND refunded_at IS NULL) AS no_result_waiting,
  (SELECT COUNT(*) FROM x402_payments WHERE (status = 'verified' AND created_at < ?1) OR status = 'unconfirmed') AS stale,
  (SELECT json_group_array(json_array(provider, status, n)) FROM (
     SELECT provider, status, COUNT(*) AS n FROM subscriptions GROUP BY provider, status ORDER BY provider, status)) AS subscriptions`;

/**
 * Останній запуск кожної задачі (json_each зі списку задач, по одному кроку індексу
 * idx_cron_runs_job на задачу), збої за добу й останній вдалий. first_recorded: з якого
 * часу журнал ведеться (найменший id), щоб «ще не запускалась» не лякало одразу після 0019.
 */
export const CRON_SQL = `SELECT j.value AS job, c.cron, c.started_at, c.ms, c.ok, c.error, c.counts_json,
  (SELECT COUNT(*) FROM cron_runs f WHERE f.job = j.value AND f.started_at >= ?2 AND f.ok = 0) AS failed_24h,
  (SELECT s.started_at FROM cron_runs s WHERE s.job = j.value AND s.ok = 1 ORDER BY s.started_at DESC LIMIT 1) AS last_ok,
  (SELECT started_at FROM cron_runs ORDER BY id LIMIT 1) AS first_recorded
FROM json_each(?1) j
LEFT JOIN cron_runs c ON c.id = (SELECT id FROM cron_runs WHERE job = j.value ORDER BY started_at DESC LIMIT 1)`;

function statements(db: D1Database, now: Date, withCron: boolean): D1PreparedStatement[] {
  const t = times(now);
  const list = [
    db.prepare(CANDIDATES_SQL).bind(t.today, t.d7, t.d30),
    db.prepare(SCORES_SQL).bind(t.d7, t.h24),
    db.prepare(DIGEST_DAYS_SQL).bind(t.digestFrom),
    db.prepare(DIGEST_MISC_SQL).bind(t.d7, t.stuck),
    db.prepare(COMPANIES_SQL).bind(t.d7),
    db.prepare(PAYMENTS_SQL).bind(t.stale5),
  ];
  if (withCron) list.push(db.prepare(CRON_SQL).bind(JSON.stringify(cronJobs().map((j) => j.job)), t.h24));
  return list;
}

// ---------------- наступний прогін добірки ----------------

const hourFormatters = new Map<string, Intl.DateTimeFormat>();

/** Година 0–23 у поясі; порожній чи невідомий пояс = UTC (як localClock в engine). */
export function localHour(at: Date, timezone: string | null | undefined): number {
  const wanted = timezone?.trim() || "UTC";
  let f = hourFormatters.get(wanted);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-GB", { timeZone: wanted, hour: "2-digit", hourCycle: "h23" });
    } catch {
      return at.getUTCHours();
    }
    hourFormatters.set(wanted, f);
  }
  const hour = f.formatToParts(at).find((p) => p.type === "hour")?.value;
  return Number(hour) % 24;
}

/** Наступний запуск таймера добірки: :05 цієї години, якщо ще не настало, інакше наступної. */
export function nextDigestRun(now: Date): Date {
  const at = new Date(now);
  at.setUTCMinutes(DIGEST_RUN_MINUTE, 0, 0);
  if (at.getTime() <= now.getTime()) at.setUTCHours(at.getUTCHours() + 1);
  return at;
}

/** Скільки людей з груп (година, пояс, кількість) мають свою годину в мить `at`. */
export function dueAt(groups: [number, string, number][], at: Date): number {
  return groups.reduce((sum, [hour, tz, n]) => (localHour(at, tz) === Number(hour) ? sum + num(n) : sum), 0);
}

// ---------------- збирання ----------------

function candidatesOf(r: Row): Overview["candidates"] {
  return {
    total: num(r.total),
    today: num(r.today),
    d7: num(r.d7),
    d30: num(r.d30),
    emailOnly: num(r.email_only),
    telegramOnly: num(r.telegram_only),
    both: num(r.both_methods),
    briefStarted: num(r.brief_started),
    briefDone: num(r.brief_done),
    xVerified: num(r.x_verified),
    wallets: num(r.wallets),
    cards: num(r.cards),
    visible: num(r.visible),
    channelTelegram: num(r.channel_telegram),
    channelEmail: num(r.channel_email),
    paused: num(r.paused),
  };
}

function scoresOf(r: Row): Overview["scores"] {
  const activity = [time(r.last_finished), time(r.last_started), time(r.last_score)].filter((t): t is number => t !== null);
  return {
    usersScored: num(r.users_scored),
    queued: num(r.queued),
    running: num(r.running),
    oldestQueuedAt: time(r.oldest_queued),
    failed24h: num(r.failed_24h),
    done24h: num(r.done_24h),
    lastEngineAt: activity.length ? Math.max(...activity) : null,
    versions: json<[string, number, number][]>(r.versions, []).map(([version, users, published]) => ({
      version: String(version),
      users: num(users),
      published: num(published) === 1,
    })),
    quality:
      typeof r.q_version === "string"
        ? {
            version: r.q_version,
            nearPct: num(r.q_near),
            exactPct: num(r.q_exact),
            people: num(r.q_people),
            passed: num(r.q_passed) === 1,
            runAt: time(r.q_run_at),
          }
        : null,
  };
}

function digestDays(rows: Row[], now: Date): DigestDay[] {
  const byDay = new Map(rows.map((r) => [String(r.day), r]));
  const today = startOfUtcDay(now).getTime();
  return Array.from({ length: 7 }, (_, i) => {
    const day = new Date(today - i * DAY).toISOString().slice(0, 10);
    const r = byDay.get(day) ?? {};
    return {
      day,
      runs: num(r.runs),
      sent: num(r.sent),
      failed: num(r.failed),
      empty: num(r.empty),
      pending: num(r.pending),
      telegram: num(r.telegram),
      email: num(r.email),
      jobsSent: num(r.jobs_sent),
    };
  });
}

function companiesOf(r: Row): Overview["companies"] {
  const b = json<Record<string, number>>(r.buckets, {});
  const usage = json<{ searches?: number; views?: number }>(r.usage, {});
  return {
    trial: num(b.trial),
    subscribed: num(b.subscribed),
    payPerRequest: num(b.pay_per_request),
    pendingReview: num(b.pending_review),
    suspended: num(b.suspended),
    closed: num(b.closed) + num(b.rejected),
    agenciesPending: num(r.agencies_pending),
    members: num(r.members),
    invitesOpen: num(r.invites_open),
    searches7d: num(usage.searches),
    views7d: num(usage.views),
    intros7d: num(r.intros_7d),
    intros: json<Record<string, number>>(r.intros, {}),
    openJobs: num(r.open_jobs),
    liveJobs: num(r.live_jobs),
    applyClicksTotal: num(r.apply_clicks),
    xQueue: num(r.x_queue),
  };
}

function paymentsOf(r: Row): Overview["payments"] {
  return {
    x402: json<Record<string, number>>(r.x402, {}),
    settledCents: num(r.settled_cents),
    noResultWaiting: num(r.no_result_waiting),
    stale: num(r.stale),
    subscriptions: json<[string, string, number][]>(r.subscriptions, []).map(([provider, status, n]) => ({
      provider: String(provider),
      status: String(status),
      n: num(n),
    })),
  };
}

function cronOf(rows: Row[] | null, error: string | null, now: number): Overview["cron"] {
  const list = cronJobs();
  if (!rows) {
    return {
      available: false,
      error,
      firstRecordedAt: null,
      jobs: list.map(({ job, cron }) => ({
        job, cron, lastAt: null, ok: null, ms: null, error: null, counts: null, lastOkAt: null, failed24h: 0, late: false,
      })),
    };
  }
  const byJob = new Map(rows.map((r) => [String(r.job), r]));
  const firstRecordedAt = time(rows[0]?.first_recorded);
  return {
    available: true,
    error: null,
    firstRecordedAt,
    jobs: list.map(({ job, cron }) => {
      const r = byJob.get(job) ?? {};
      const lastAt = time(r.started_at);
      const lateAfter = CRON_LATE_AFTER_MS[cron] ?? DAY;
      // Немає жодного запуску: запізнення, лише якщо журнал ведеться довше, ніж задача мала чекати.
      const since = lastAt ?? firstRecordedAt;
      const late = since === null ? cron === CRONS.every5Minutes : now - since > lateAfter;
      return {
        job,
        cron,
        lastAt,
        ok: r.ok === undefined || r.ok === null ? null : num(r.ok) === 1,
        ms: r.ms === undefined || r.ms === null ? null : num(r.ms),
        error: typeof r.error === "string" ? r.error : null,
        counts: json<Record<string, number> | null>(r.counts_json, null),
        lastOkAt: time(r.last_ok),
        failed24h: num(r.failed_24h),
        late,
      };
    }),
  };
}

function rowsReadOf(results: D1Result[]): number | null {
  let total = 0;
  for (const r of results) {
    const read = (r.meta as { rows_read?: number } | undefined)?.rows_read;
    if (typeof read !== "number") return null;
    total += read;
  }
  return total;
}

/**
 * Усе для головної одним пакетом. Якщо 0019 ще не накочено, пакет з cron_runs падає
 * цілком (D1 виконує пакет однією транзакцією), тож повторюємо без нього, а блок cron
 * каже, чого бракує.
 */
export async function loadOverview(db: D1Database, now: Date = new Date()): Promise<Overview> {
  let results: D1Result<Row>[];
  let cronError: string | null = null;
  try {
    results = await db.batch<Row>(statements(db, now, true));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (!/no such table:?\s*(main\.)?cron_runs/i.test(message)) throw e;
    cronError = "cron_runs is missing: migration 0019 is not applied yet.";
    results = await db.batch<Row>(statements(db, now, false));
  }
  const [cand, scores, days, misc, companies, payments, cron] = results.map((r) => r.results ?? []);
  const m = misc[0] ?? {};
  const candidates = candidatesOf(cand[0] ?? {});
  const groups = json<[number, string, number][]>(m.due_groups, []);
  const nextRun = nextDigestRun(now);
  return {
    now: now.getTime(),
    candidates,
    scores: scoresOf(scores[0] ?? {}),
    digests: {
      days: digestDays(days, now),
      newestRunAt: time(m.newest_run),
      stuckPending: num(m.stuck),
      failureReasons: json<[string, number][]>(m.reasons, []).map(([reason, n]) => ({ reason: String(reason), n: num(n) })),
      eligible: groups.reduce((s, g) => s + num(g[2]), 0),
      nextRunAt: nextRun.getTime(),
      dueNext: dueAt(groups, nextRun),
    },
    companies: companiesOf(companies[0] ?? {}),
    payments: paymentsOf(payments[0] ?? {}),
    cron: cronOf(cron ?? null, cronError, now.getTime()),
    rowsRead: rowsReadOf(results),
    statements: results.length,
  };
}

// ---------------- червоні прапорці ----------------

export type Flag = {
  /** alert: щось стоїть або зламано; todo: чекає на адміна. */
  level: "alert" | "todo";
  text: string;
  href?: string;
};

/** «1 job», «2 jobs». */
function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function ageText(ms: number): string {
  const min = Math.max(0, Math.floor(ms / MIN));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return h < 48 ? `${h} h` : `${Math.floor(h / 24)} d`;
}

/**
 * Що запізнилось або чекає. Правила:
 * - задача cron без запуску довше за CRON_LATE_AFTER_MS її тригера, або останній запуск упав;
 * - рушій балу: у черзі є задачі, а запису рушія не було ENGINE_IDLE_ALERT_MS; або найстаріша
 *   задача чекає довше за QUEUE_WAIT_ALERT_MS;
 * - версія формули в ужитку без вдалого прогону воріт якості: компанії не бачать цих балів;
 * - добірка: є кому слати, а прогону не було DIGEST_IDLE_ALERT_MS; завислі 'pending';
 * - сканер вакансій пропустив плановий щоденний скан (lib/admin/job-sources.ts scannerMissed);
 * - оплати без результату, що чекають повернення, і завислі платежі x402;
 * - заявки агенцій і черга X чекають на адміна.
 */
export function overviewFlags(o: Overview, jobs: { report: JobSourcesReport | null; error: string | null }): Flag[] {
  const flags: Flag[] = [];
  const now = o.now;

  if (!o.cron.available) {
    flags.push({ level: "alert", text: o.cron.error ?? "Cron history is not available." });
  } else {
    const late = o.cron.jobs.filter((j) => j.late);
    for (const j of late) {
      flags.push({
        level: "alert",
        text: j.lastAt === null ? `Cron ${j.job} (${j.cron}): no run recorded yet.` : `Cron ${j.job} (${j.cron}) is late: last run ${ageText(now - j.lastAt)} ago.`,
      });
    }
    for (const j of o.cron.jobs.filter((x) => x.ok === false && !x.late)) {
      flags.push({ level: "alert", text: `Cron ${j.job}: the last run failed${j.error ? `: ${j.error}` : "."}` });
    }
  }

  const s = o.scores;
  if (s.queued > 0 && (s.lastEngineAt === null || now - s.lastEngineAt > ENGINE_IDLE_ALERT_MS)) {
    flags.push({
      level: "alert",
      text: `Scoring engine idle ${s.lastEngineAt === null ? "(no activity recorded)" : `for ${ageText(now - s.lastEngineAt)}`} with ${s.queued} queued.`,
    });
  } else if (s.oldestQueuedAt !== null && now - s.oldestQueuedAt > QUEUE_WAIT_ALERT_MS) {
    flags.push({ level: "alert", text: `Scoring queue: the oldest job has waited ${ageText(now - s.oldestQueuedAt)}.` });
  }
  for (const v of s.versions.filter((x) => !x.published)) {
    flags.push({
      level: "alert",
      text: `Formula ${v.version} has no passed quality run: companies do not see the scores of ${count(v.users, "person", "people")}.`,
    });
  }

  const d = o.digests;
  if (d.eligible > 0 && (d.newestRunAt === null || now - d.newestRunAt > DIGEST_IDLE_ALERT_MS)) {
    flags.push({
      level: "alert",
      text: `No digest run ${d.newestRunAt === null ? "recorded" : `for ${ageText(now - d.newestRunAt)}`} while ${count(d.eligible, "person", "people")} can get one.`,
    });
  }
  if (d.stuckPending > 0) {
    flags.push({ level: "alert", text: `Stuck: ${count(d.stuckPending, "digest run", "digest runs")} pending for over ${DIGEST_STUCK_MINUTES} min.` });
  }

  if (jobs.error) {
    flags.push({ level: "alert", text: `Could not read job sources: ${jobs.error}`, href: "/admin/sources" });
  } else if (jobs.report?.totals.scannerStale) {
    // scannerStale уже знає розклад (щодня о 04:30 UTC, SCAN_TIME_UTC).
    const scan = jobs.report.totals.lastScan;
    flags.push({
      level: "alert",
      text: `Job scanner missed its scheduled daily run (${SCAN_TIME_UTC})${scan ? `; last scan ${ageText(now - scan.at)} ago` : ""}.`,
      href: "/admin/sources",
    });
  }

  const p = o.payments;
  if (p.noResultWaiting > 0) {
    flags.push({
      level: "alert",
      text: `Refund needed: ${count(p.noResultWaiting, "x402 payment", "x402 payments")} settled without a result.`,
      href: "/admin/payments",
    });
  }
  if (p.stale > 0) {
    flags.push({ level: "alert", text: `Check by hand: ${count(p.stale, "x402 payment", "x402 payments")} stuck or unconfirmed.`, href: "/admin/payments" });
  }

  const c = o.companies;
  if (c.agenciesPending > 0) {
    flags.push({ level: "todo", text: `Review: ${count(c.agenciesPending, "agency application", "agency applications")}.`, href: "/admin/agency-applications" });
  }
  if (c.xQueue > 0) {
    flags.push({ level: "todo", text: `Post on X: ${count(c.xQueue, "job", "jobs")} in the queue.`, href: "/admin/x-queue" });
  }
  return flags;
}

