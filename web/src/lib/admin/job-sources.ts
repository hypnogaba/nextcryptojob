import type { JobsDb } from "@/lib/jobs-db";
import { NON_CRYPTO_COMPANIES as NON_CRYPTO } from "@/lib/jobs/clean";
import { ATS_WINDOW_DAYS, EMPLOYER_FEED_SQL, LIVE_WINDOW_DAYS, POSTED_WINDOW_DAYS, poolParams } from "@/lib/jobs/pool";

/**
 * Адмінка: звідки беремо вакансії (сторінка /admin/sources).
 *
 * Джерело це значення jobs_cache.source у базі вакансій NextCryptoJob (binding JOBS_DB,
 * db/jobs), яке пише сканер engine (engine/src/jobs). Роди:
 *   `<ats>:<slug>`       дошка роботодавця на ATS (greenhouse:coinbase, ashby:kraken.com);
 *   `board:<name>`       крипто-дошка з таблиці sources (board:web3career, board:remote3);
 *   `aggregator:<name>`  агрегатор з таблиці sources або з коду (aggregator:speedrun, aggregator:superteam).
 * Рахується за тим, що справді доїхало в базу, а не за налаштуваннями.
 *
 * База лише крипто, тож тег web3 має кожен рядок; умова на нього лишається запобіжником, а
 * рядки без жодної вакансії web3 сторінка не показує, лише каже, скільки їх.
 */

// Правило «жива вакансія» і сито web3 з web-копій правил engine (lib/jobs/pool.ts і lib/jobs/clean.ts,
// тест parity.test.ts тримає їх дослівними з engine/src/digest/jobs.ts і clean.ts), не своя копія.
export { ATS_WINDOW_DAYS, LIVE_WINDOW_DAYS, POSTED_WINDOW_DAYS };

/** engine/src/digest/clean.ts NON_CRYPTO_COMPANIES: тег web3 є, але компанія не крипто. */
export const NON_CRYPTO_COMPANIES: readonly string[] = [...NON_CRYPTO];

/**
 * Розклад сканера (engine/deploy/nextcryptojob-jobs-scan.timer): щодня, і у вихідні теж, о 04:30 UTC.
 * «Давно не бачили» міряємо пропущеними плановими сканами, а не годинами. Скан рахується таким,
 * що мав відбутися, через SCAN_GRACE_HOURS після планового часу; почати він міг до SCAN_EARLY_MS раніше.
 * Змінюючи час, змінити й таймер.
 */
export const SCAN_HOUR_UTC = 4;
export const SCAN_MINUTE_UTC = 30;
/** Для текстів: «04:30 UTC». */
export const SCAN_TIME_UTC = `${String(SCAN_HOUR_UTC).padStart(2, "0")}:${String(SCAN_MINUTE_UTC).padStart(2, "0")} UTC`;
export const SCAN_GRACE_HOURS = 3;
/** Джерело застигле, якщо його не було в стільки останніх планових сканах. */
export const STALE_AFTER_SCANS = 2;
/** Скільки живе готовий звіт у пам'яті ізолята. */
export const CACHE_TTL_MS = 10 * 60_000;

const HOUR_MS = 3_600_000;
const SCAN_EARLY_MS = HOUR_MS;

/**
 * Один запит на весь звіт; jobs_cache читається рівно раз (GROUP BY source).
 *
 * Індексу на fetched_at чи source у jobs_cache немає навмисно (db/jobs/0001_schema.sql: скан
 * щодня переписує fetched_at, а записи D1 у тисячу разів дорожчі за читання). Тож це повний
 * прохід по таблиці плюс сортування для GROUP BY; база лише крипто (тисячі рядків), і звіт
 * ще й кешується.
 *
 * Сито те саме, що в engine: тег web3 (LIKE, як POOL_SQL), компанія не
 * з NON_CRYPTO_COMPANIES (тут лише за company_key, engine ще й за назвою), живе = те саме
 * правило, що POOL_SQL: рядок з останнього вдалого скану свого джерела (найсвіжіший fetched_at
 * джерела, вікном), той скан не давніший за LIVE_WINDOW_DAYS, і вік від публікації (без дати від
 * first_seen_at) не більше ATS_WINDOW_DAYS для фіду роботодавця на ATS чи POSTED_WINDOW_DAYS для дошки.
 * Сито ролей за назвою (engine roles.ts) сюди не входить: воно про людину, а не
 * про джерело. Час у jobs_cache ISO з 'T' і 'Z', тож і межі ISO.
 *
 * sources дає назву й сайт дошки: крихітна таблиця з первинним ключем. Останній скан:
 * scan_runs за видом 'scan' (індекс idx_scan_runs_kind_started, один рядок).
 * COUNT(*) OVER () рахує всі джерела до фільтра web3.
 */
export const SOURCES_SQL = `SELECT s.source, s.company, s.web3_jobs, s.live_jobs, s.live_salary, s.newest,
       s.all_sources, b.label AS board_label, COALESCE(b.site_url, b.feed_url) AS board_url,
       (SELECT started_at FROM scan_runs WHERE kind = 'scan' ORDER BY started_at DESC LIMIT 1) AS last_scan_at,
       (SELECT status FROM scan_runs WHERE kind = 'scan' ORDER BY started_at DESC LIMIT 1) AS last_scan_status
  FROM (SELECT source,
               MAX(company) AS company,
               SUM(w) AS web3_jobs,
               SUM(w AND l) AS live_jobs,
               SUM(w AND l AND (salary_min IS NOT NULL OR salary_max IS NOT NULL)) AS live_salary,
               MAX(fetched_at) AS newest,
               COUNT(*) OVER () AS all_sources
          FROM (SELECT source, company, fetched_at, salary_min, salary_max,
                       (tags LIKE '%"web3"%' AND instr(?, '|' || company_key || '|') = 0) AS w,
                       (fetched_at >= ? AND fetched_at = MAX(fetched_at) OVER (PARTITION BY source)
                        AND COALESCE(posted_at, first_seen_at) >= CASE WHEN ${EMPLOYER_FEED_SQL} THEN ? ELSE ? END) AS l
                  FROM jobs_cache)
         GROUP BY source) s
  LEFT JOIN sources b ON b.name = s.source
 WHERE s.web3_jobs > 0
 ORDER BY s.live_jobs DESC, s.web3_jobs DESC, s.source`;

/**
 * Параметри SOURCES_SQL: [список не-крипто компаній, ...poolParams: запас для джерела, що не
 * прочиталось, межа віку ATS, межа віку дошки]. Список іде рядком '|perle|crusoe|…|' для instr, а не як NOT IN (…):
 * з NOT IN на живій базі rows_read зростав з 119 до 290 тис., бо D1 рахує кожну
 * пробу в тимчасовий індекс списку. instr лише порівнює рядки. У company_key
 * лише літери, цифри й пробіли, тож '|' в ньому не трапиться.
 */
export function sourcesParams(now: Date): [string, string, string, string] {
  return [`|${NON_CRYPTO_COMPANIES.join("|")}|`, ...poolParams(now)];
}

/** Рядок SOURCES_SQL як його віддає D1. */
export type SourceAggRow = {
  source: string;
  company: string | null;
  web3_jobs: number;
  live_jobs: number;
  live_salary: number;
  newest: string | null;
  all_sources: number;
  board_label: string | null;
  board_url: string | null;
  last_scan_at: string | null;
  last_scan_status: string | null;
};

export type SourceKind = "ats" | "aggregator" | "board" | "other";

export type JobSource = {
  /** jobs_cache.source як є. */
  key: string;
  name: string;
  kind: SourceKind;
  /** Підпис роду для таблиці: «Greenhouse», «Aggregator», «Job board». */
  via: string;
  url: string | null;
  web3Jobs: number;
  liveJobs: number;
  liveWithSalary: number;
  /** Найсвіжіший fetched_at джерела, мс UTC. */
  newestAt: number | null;
  stale: boolean;
};

/** Дошки ATS: як скласти адресу сторінки вакансій компанії зі слага. */
const ATS: Record<string, { label: string; url: ((slug: string) => string) | null }> = {
  greenhouse: { label: "Greenhouse", url: (s) => `https://job-boards.greenhouse.io/${s}` },
  lever: { label: "Lever", url: (s) => `https://jobs.lever.co/${s}` },
  lever_eu: { label: "Lever EU", url: (s) => `https://jobs.eu.lever.co/${s}` },
  teamtailor: { label: "Teamtailor", url: (s) => `https://${s}.teamtailor.com/jobs` },
  ashby: { label: "Ashby", url: (s) => `https://jobs.ashbyhq.com/${s}` },
  workable: { label: "Workable", url: (s) => `https://apply.workable.com/${s}/` },
  smartrecruiters: { label: "SmartRecruiters", url: (s) => `https://jobs.smartrecruiters.com/${s}` },
  breezy: { label: "Breezy", url: (s) => `https://${s}.breezy.hr/` },
  recruitee: { label: "Recruitee", url: (s) => `https://${s}.recruitee.com/` },
  rippling: { label: "Rippling", url: (s) => `https://ats.rippling.com/${s}/jobs` },
  personio: { label: "Personio", url: (s) => `https://${s}.jobs.personio.de/` },
  bamboohr: { label: "BambooHR", url: (s) => `https://${s}.bamboohr.com/careers` },
  gem: { label: "Gem", url: (s) => `https://jobs.gem.com/${s}` },
  pinpoint: { label: "Pinpoint", url: (s) => `https://${s}.pinpointhq.com/` },
  hibob: { label: "HiBob", url: (s) => `https://${s}.careers.hibob.com/` },
  // Слаг Comeet несе токен, а в ключі джерела лише uid: окремої сторінки компанії зі слага не скласти.
  comeet: { label: "Comeet", url: null },
  workday: { label: "Workday", url: (s) => { const [t, wd, ...site] = s.split("."); return `https://${t}.${wd}.myworkdayjobs.com/${site.join(".")}`; } },
};

/** Агрегатори, яких може не бути в таблиці sources (Superteam вмикається змінною engine): назва й сайт. */
const AGGREGATORS: Record<string, { name: string; url: string }> = {
  speedrun: { name: "a16z speedrun", url: "https://speedrun-talent-network.com" },
  superteam: { name: "Superteam Earn", url: "https://superteam.fun/earn" },
};

/** Лише http(s): посилання з бази йде в href. */
function safeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
  } catch {
    return null;
  }
}

/** Стрічка дошки (RSS чи API) людині не сторінка: показуємо сам сайт. */
function siteOf(feed: string | null): string | null {
  const url = safeUrl(feed);
  return url ? `${new URL(url).origin}/` : null;
}

/** Назва, рід і посилання джерела з його ключа й таблиці sources. */
export function describeSource(row: Pick<SourceAggRow, "source" | "company" | "board_label" | "board_url">,
): Pick<JobSource, "name" | "kind" | "via" | "url"> {
  const i = row.source.indexOf(":");
  const prefix = i === -1 ? row.source : row.source.slice(0, i);
  const rest = i === -1 ? "" : row.source.slice(i + 1);

  if (prefix === "board") {
    return { name: row.board_label?.trim() || rest, kind: "board", via: "Job board", url: siteOf(row.board_url) };
  }
  if (prefix === "aggregator") {
    const known = AGGREGATORS[rest];
    return { name: row.board_label?.trim() || known?.name || rest, kind: "aggregator", via: "Aggregator",
      url: siteOf(row.board_url) ?? known?.url ?? null };
  }
  const ats = ATS[prefix];
  if (ats && rest) {
    // Слаг Ashby буває з %20 (Sui%20Foundation): уже закодований, вдруге не кодуємо.
    const slug = /%[0-9a-f]{2}/i.test(rest) ? rest : encodeURIComponent(rest);
    return { name: row.company?.trim() || rest, kind: "ats", via: ats.label, url: ats.url ? ats.url(slug) : null };
  }
  return { name: row.source, kind: "other", via: prefix || "Unknown", url: null };
}

/**
 * Дата з бази: ISO ('…T…Z', пише сканер) або SQLite ('YYYY-MM-DD HH:MM:SS', UTC,
 * пишемо ми). Те саме правило, що engine/src/digest/jobs.ts parseDbTime.
 */
export function parseDbTime(v: string | null | undefined): number | null {
  if (!v) return null;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(v) ? `${v.replace(" ", "T")}Z` : v;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : t;
}

/** Скільки часу минуло, коротко: «just now», «5 min ago», «7 h ago», «3 d ago». */
export function ago(at: number, now: number): string {
  const min = Math.max(0, Math.floor((now - at) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} d ago`;
}

/**
 * Планові скани, що вже мали відбутися (04:30 UTC щодня + SCAN_GRACE_HOURS не пізніше за now),
 * від найсвіжішого. Сканер ходить і у вихідні, тож субота нічим не відрізняється від вівторка.
 */
export function pastScanSlots(now: Date, count: number): number[] {
  const out: number[] = [];
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SCAN_HOUR_UTC, SCAN_MINUTE_UTC));
  while (out.length < count) {
    if (slot.getTime() + SCAN_GRACE_HOURS * HOUR_MS <= now.getTime()) out.push(slot.getTime());
    slot.setUTCDate(slot.getUTCDate() - 1);
  }
  return out;
}

/** Застигле: джерела не було в STALE_AFTER_SCANS останніх планових сканах (або ніколи). */
export function isStale(newestAt: number | null, now: Date): boolean {
  if (newestAt === null) return true;
  const slots = pastScanSlots(now, STALE_AFTER_SCANS);
  return newestAt < slots[slots.length - 1] - SCAN_EARLY_MS;
}

/** Сканер пропустив останній плановий скан: жодного запуску з того 04:30 UTC. */
export function scannerMissed(lastScanAt: number | null, now: Date): boolean {
  return lastScanAt === null || lastScanAt < pastScanSlots(now, 1)[0] - SCAN_EARLY_MS;
}

export function toJobSource(row: SourceAggRow, now: Date): JobSource {
  const newestAt = parseDbTime(row.newest);
  return {
    key: row.source,
    ...describeSource(row),
    web3Jobs: Number(row.web3_jobs) || 0,
    liveJobs: Number(row.live_jobs) || 0,
    liveWithSalary: Number(row.live_salary) || 0,
    newestAt,
    stale: isStale(newestAt, now),
  };
}

/** Рядок «Company jobs (NextCryptoJob)»: вакансії компаній у нашій базі. */
export type CompanyJobsSummary = {
  /** company_jobs зі status = 'open'. */
  openJobs: number;
  /** З них у добірці зараз (подання company_jobs_live: не приховані, не прострочені, з доступом). */
  liveJobs: number;
  liveWithSalary: number;
  /** Найсвіжіша публікація серед відкритих, мс UTC. */
  newestAt: number | null;
};

export const COMPANY_JOBS_SQL = `SELECT
  (SELECT COUNT(*) FROM company_jobs WHERE status = 'open') AS open_jobs,
  (SELECT MAX(published_at) FROM company_jobs WHERE status = 'open') AS newest,
  (SELECT COUNT(*) FROM company_jobs_live) AS live_jobs,
  (SELECT COUNT(*) FROM company_jobs_live WHERE salary_min IS NOT NULL OR salary_max IS NOT NULL) AS live_salary`;

export type LastScan = { at: number; status: string | null } | null;

export type JobSourcesTotals = {
  /** Живі вакансії web3: сума по джерелах сканування плюс вакансії компаній. До злиття дублікатів між джерелами. */
  liveJobs: number;
  crawlLiveJobs: number;
  companyLiveJobs: number;
  /** Джерела з вакансіями web3, які були хоч в одному з STALE_AFTER_SCANS останніх сканів. */
  activeSources: number;
  staleSources: number;
  /** Скільки всього джерел у базі вакансій, і з web3, і без. */
  allSources: number;
  /** Останній скан: scan_runs, а якщо таблиця порожня, найсвіжіший fetched_at. */
  lastScan: LastScan;
  /** Сканер пропустив плановий щоденний скан (scannerMissed): тоді й джерела застигають, і причина в ньому. */
  scannerStale: boolean;
};

export type JobSourcesReport = {
  sources: JobSource[];
  company: CompanyJobsSummary;
  totals: JobSourcesTotals;
  /** Коли звіт пораховано (мс UTC): для «Updated N min ago». */
  computedAt: number;
};

export function summarize(rows: SourceAggRow[], sources: JobSource[], company: CompanyJobsSummary, now: Date): JobSourcesTotals {
  const crawlLiveJobs = sources.reduce((n, s) => n + s.liveJobs, 0);
  const first = rows[0];
  const scanAt = parseDbTime(first?.last_scan_at);
  const newest = sources.reduce<number | null>((m, s) => (s.newestAt !== null && (m === null || s.newestAt > m) ? s.newestAt : m), null);
  const lastScan: LastScan = scanAt !== null
    ? { at: scanAt, status: first?.last_scan_status ?? null }
    : newest !== null ? { at: newest, status: null } : null;
  return {
    liveJobs: crawlLiveJobs + company.liveJobs,
    crawlLiveJobs,
    companyLiveJobs: company.liveJobs,
    activeSources: sources.filter((s) => !s.stale).length,
    staleSources: sources.filter((s) => s.stale).length,
    allSources: Number(first?.all_sources) || 0,
    lastScan,
    scannerStale: scannerMissed(lastScan?.at ?? null, now),
  };
}

/** Звіт з обох баз: один запит до jobs_cache (JOBS_DB) і один до нашої DB. */
export async function loadJobSourcesReport(jobs: JobsDb, main: D1Database, now: Date): Promise<JobSourcesReport> {
  const [rows, co] = await Promise.all([
    jobs.all<SourceAggRow>(SOURCES_SQL, ...sourcesParams(now)),
    main.prepare(COMPANY_JOBS_SQL).first<{ open_jobs: number; newest: string | null; live_jobs: number; live_salary: number }>(),
  ]);
  const sources = rows.map((r) => toJobSource(r, now));
  const company: CompanyJobsSummary = {
    openJobs: Number(co?.open_jobs) || 0,
    liveJobs: Number(co?.live_jobs) || 0,
    liveWithSalary: Number(co?.live_salary) || 0,
    newestAt: parseDbTime(co?.newest),
  };
  return { sources, company, totals: summarize(rows, sources, company, now), computedAt: now.getTime() };
}

/**
 * Кеш звіту в пам'яті модуля, на ізолят Worker, на CACHE_TTL_MS.
 *
 * Не Cache API: кешуємо не відповідь, а дані для сторінки, і сторінка під сесією
 * адміна. Ізолят живе довго лише під навантаженням, тож промах можливий частіше
 * за раз на 10 хвилин, але адмін один, і промах коштує один запит. Незавершений
 * запит між запитами не ділимо: у Workers проміс, що чекає на I/O іншого запиту,
 * може зависнути. Помилка не кешується: наступне відкриття спробує знову.
 */
let cached: JobSourcesReport | null = null;

export async function cachedJobSourcesReport(
  load: (now: Date) => Promise<JobSourcesReport>,
  now: Date = new Date(),
): Promise<JobSourcesReport> {
  if (cached && now.getTime() - cached.computedAt >= 0 && now.getTime() - cached.computedAt < CACHE_TTL_MS) {
    return cached;
  }
  const report = await load(now);
  cached = report;
  return report;
}

/** Для тестів: забути кеш. */
export function resetJobSourcesCache(): void {
  cached = null;
}
