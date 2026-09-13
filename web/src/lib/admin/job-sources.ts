import type { JobsDb } from "@/lib/jobs-db";

/**
 * Адмінка: звідки беремо вакансії (сторінка /admin/sources).
 *
 * Джерело тут те саме, що в NextRole: значення jobs_cache.source, яке пише
 * сканер NextRole (crypto-jobs-agent/scanner/src/sources/*). Роди:
 *   `<ats>:<slug>`       дошка компанії на ATS (greenhouse:coinbase, ashby:phantom);
 *   `aggregator:<name>`  агрегатор (aggregator:remoteok, aggregator:hn);
 *   `board:<name>`       дошка з таблиці country_boards (board:global-web3career);
 *   `getro:<id>`         колекція Getro з таблиці getro_collections (getro:858 = Solana).
 * У NextRole це блок «Джерела» панелі власника (web/src/app/(app)/admin/page.tsx),
 * рахується так само: за тим, що справді доїхало в кеш, а не за налаштуваннями.
 *
 * Нам потрібні лише джерела з вакансіями web3, тож рядки без жодної такої
 * вакансії сторінка не показує, а лише каже, скільки їх.
 */

// Вікна й сито web3 скопійовано з engine, не імпортовано: engine окремий пакет.
// Міняти разом з ним: engine/src/digest/jobs.ts (LIVE_WINDOW_DAYS,
// POSTED_WINDOW_DAYS, NEXTROLE_POOL_SQL) і engine/src/digest/clean.ts
// (NON_CRYPTO_COMPANIES).

/** engine/src/digest/jobs.ts LIVE_WINDOW_DAYS: скільки днів тому скан мав бачити вакансію. */
export const LIVE_WINDOW_DAYS = 3;
/** engine/src/digest/jobs.ts POSTED_WINDOW_DAYS: давніше опубліковане в добірку не йде. */
export const POSTED_WINDOW_DAYS = 30;

/** engine/src/digest/clean.ts NON_CRYPTO_COMPANIES: тег web3 є, але компанія не крипто. */
export const NON_CRYPTO_COMPANIES: readonly string[] = [
  "perle", "crusoe", "ping identity", "zscaler", "sophos", "notion", "ashby", "zinnia", "inmobi", "virtuozzo",
  "givedirectly", "fuse energy", "dynamo ai", "discord", "stockx", "str", "blackrock", "wave mobile money",
  "lunar a s", "funding circle", "shippo", "cyberhaven", "integra", "current mobile", "immuta", "greenhouse",
  "branch", "cross river", "auxmoney", "clue", "masterclass", "axiom", "launchpadtechnologiesinc", "stash",
  "transmit security", "sift", "cls", "groma", "webai", "hyperbolic", "hyperbolic labs", "wealthsimple",
  "bcg attorney search",
];

/**
 * Розклад сканера NextRole: лише будні (пн-пт) о 03:00 UTC. У вихідні скану немає, тож
 * «давно не бачили» міряємо не годинами, а пропущеними плановими сканами: інакше щосуботи
 * застиглими ставали б усі джерела. Скан рахується таким, що мав відбутися, через
 * SCAN_GRACE_HOURS після планового часу; почати він міг до SCAN_EARLY_MS раніше.
 */
export const SCAN_HOUR_UTC = 3;
/** Для текстів: «03:00 UTC». */
export const SCAN_TIME_UTC = `${String(SCAN_HOUR_UTC).padStart(2, "0")}:00 UTC`;
export const SCAN_GRACE_HOURS = 3;
/** Джерело застигле, якщо його не було в стільки останніх планових сканах. */
export const STALE_AFTER_SCANS = 2;
/** Скільки живе готовий звіт у пам'яті ізолята. */
export const CACHE_TTL_MS = 10 * 60_000;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const SCAN_EARLY_MS = HOUR_MS;

/**
 * Один запит на весь звіт; jobs_cache читається рівно раз (GROUP BY source).
 *
 * Індексу на fetched_at чи source у jobs_cache немає навмисно (записи D1 дорогі,
 * NextRole зняв індекс 04.09), і додавати його звідси не можна: база чужа й лише
 * для читання. Тож це повний прохід по таблиці плюс сортування для GROUP BY:
 * 12.09 на живій базі ~119 тис. rows_read на 57 тис. рядків. Тому звіт кешується.
 *
 * Сито те саме, що в engine: тег web3 (LIKE, як NEXTROLE_POOL_SQL), компанія не
 * з NON_CRYPTO_COMPANIES (тут лише за company_key, engine ще й за назвою), живе =
 * скан бачив за LIVE_WINDOW_DAYS і опубліковано не давніше POSTED_WINDOW_DAYS.
 * Сито ролей за назвою (engine roles.ts) сюди не входить: воно про людину, а не
 * про джерело. Час у jobs_cache ISO з 'T' і 'Z', тож і межі ISO.
 *
 * country_boards і getro_collections дають назву й посилання: це крихітні
 * таблиці з унікальними ключами, приєднання коштує кілька десятків rows_read.
 * COUNT(*) OVER () рахує всі джерела до фільтра web3 (ще ~5 тис. rows_read).
 */
export const SOURCES_SQL = `SELECT s.source, s.company, s.web3_jobs, s.live_jobs, s.live_salary, s.newest,
       s.all_sources, b.label AS board_label, b.feed_url AS board_url, b.country AS board_country,
       g.label AS getro_label, g.url AS getro_url,
       (SELECT started_at FROM scan_runs ORDER BY started_at DESC LIMIT 1) AS last_scan_at,
       (SELECT status FROM scan_runs ORDER BY started_at DESC LIMIT 1) AS last_scan_status
  FROM (SELECT source,
               MAX(company) AS company,
               SUM(w) AS web3_jobs,
               SUM(w AND l) AS live_jobs,
               SUM(w AND l AND (salary_min IS NOT NULL OR salary_max IS NOT NULL)) AS live_salary,
               MAX(fetched_at) AS newest,
               COUNT(*) OVER () AS all_sources
          FROM (SELECT source, company, fetched_at, salary_min, salary_max,
                       (tags LIKE '%"web3"%' AND instr(?, '|' || company_key || '|') = 0) AS w,
                       (fetched_at >= ? AND (posted_at IS NULL OR posted_at >= ?)) AS l
                  FROM jobs_cache)
         GROUP BY source) s
  LEFT JOIN country_boards b ON b.name = s.source
  LEFT JOIN getro_collections g ON s.source LIKE 'getro:%' AND g.collection_id = CAST(SUBSTR(s.source, 7) AS INTEGER)
 WHERE s.web3_jobs > 0
 ORDER BY s.live_jobs DESC, s.web3_jobs DESC, s.source`;

/**
 * Параметри SOURCES_SQL: [список не-крипто компаній, бачили не раніше, опубліковано
 * не раніше]. Список іде рядком '|perle|crusoe|…|' для instr, а не як NOT IN (…):
 * з NOT IN на живій базі rows_read зростав з 119 до 290 тис., бо D1 рахує кожну
 * пробу в тимчасовий індекс списку. instr лише порівнює рядки. У company_key
 * лише літери, цифри й пробіли, тож '|' в ньому не трапиться.
 */
export function sourcesParams(now: Date): [string, string, string] {
  return [
    `|${NON_CRYPTO_COMPANIES.join("|")}|`,
    new Date(now.getTime() - LIVE_WINDOW_DAYS * DAY_MS).toISOString(),
    new Date(now.getTime() - POSTED_WINDOW_DAYS * DAY_MS).toISOString(),
  ];
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
  board_country: string | null;
  getro_label: string | null;
  getro_url: string | null;
  last_scan_at: string | null;
  last_scan_status: string | null;
};

export type SourceKind = "ats" | "aggregator" | "board" | "getro" | "other";

export type JobSource = {
  /** jobs_cache.source як є. */
  key: string;
  name: string;
  kind: SourceKind;
  /** Підпис роду для таблиці: «Greenhouse», «Aggregator», «Job board», «Getro». */
  via: string;
  url: string | null;
  /** Країна дошки (country_boards.country), якщо дошка не для всіх. */
  country: string | null;
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
  ashby: { label: "Ashby", url: (s) => `https://jobs.ashbyhq.com/${s}` },
  workable: { label: "Workable", url: (s) => `https://apply.workable.com/${s}/` },
  smartrecruiters: { label: "SmartRecruiters", url: (s) => `https://jobs.smartrecruiters.com/${s}` },
  breezy: { label: "Breezy", url: (s) => `https://${s}.breezy.hr/` },
  recruitee: { label: "Recruitee", url: (s) => `https://${s}.recruitee.com/` },
  rippling: { label: "Rippling", url: (s) => `https://ats.rippling.com/${s}/jobs` },
  personio: { label: "Personio", url: (s) => `https://${s}.jobs.personio.de/` },
  bamboohr: { label: "BambooHR", url: (s) => `https://${s}.bamboohr.com/careers` },
  // workday:<tenant> без номера сервера й сайту: адресу не скласти.
  workday: { label: "Workday", url: null },
};

/** Агрегатори NextRole (scanner/src/sources/aggregators.ts і speedrun): назва й сайт. */
const AGGREGATORS: Record<string, { name: string; url: string }> = {
  arbeitnow: { name: "Arbeitnow", url: "https://www.arbeitnow.com" },
  remotive: { name: "Remotive", url: "https://remotive.com" },
  remoteok: { name: "Remote OK", url: "https://remoteok.com" },
  jobicy: { name: "Jobicy", url: "https://jobicy.com" },
  himalayas: { name: "Himalayas", url: "https://himalayas.app" },
  workingnomads: { name: "Working Nomads", url: "https://www.workingnomads.com" },
  landingjobs: { name: "Landing.jobs", url: "https://landing.jobs" },
  themuse: { name: "The Muse", url: "https://www.themuse.com" },
  wwr: { name: "We Work Remotely", url: "https://weworkremotely.com" },
  jobspresso: { name: "Jobspresso", url: "https://jobspresso.co" },
  nodesk: { name: "NoDesk", url: "https://nodesk.co" },
  cryptocurrencyjobs: { name: "Cryptocurrency Jobs", url: "https://cryptocurrencyjobs.co" },
  hn: { name: "Hacker News: Who is hiring", url: "https://news.ycombinator.com" },
  speedrun: { name: "a16z speedrun", url: "https://speedrun.a16z.com" },
};

/** Лише http(s): посилання з чужої бази йде в href. */
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

/** Назва, рід і посилання джерела з його ключа й приєднаних довідників. */
export function describeSource(row: Pick<SourceAggRow,
  "source" | "company" | "board_label" | "board_url" | "board_country" | "getro_label" | "getro_url">,
): Pick<JobSource, "name" | "kind" | "via" | "url" | "country"> {
  const i = row.source.indexOf(":");
  const prefix = i === -1 ? row.source : row.source.slice(0, i);
  const rest = i === -1 ? "" : row.source.slice(i + 1);

  if (prefix === "board") {
    const country = row.board_country && row.board_country !== "*" ? row.board_country : null;
    return { name: row.board_label?.trim() || rest, kind: "board", via: "Job board", url: siteOf(row.board_url), country };
  }
  if (prefix === "getro") {
    return {
      name: row.getro_label?.trim() || `Getro collection ${rest}`, kind: "getro", via: "Getro",
      url: safeUrl(row.getro_url) ?? "https://getro.com", country: null,
    };
  }
  if (prefix === "aggregator") {
    // wwr-<рубрика>: та сама дошка We Work Remotely, лише рубрика.
    const base = rest.startsWith("wwr-") ? "wwr" : rest;
    const known = AGGREGATORS[base];
    const name = known ? (base === rest ? known.name : `${known.name} (${rest.slice(4)})`) : rest;
    return { name, kind: "aggregator", via: "Aggregator", url: known?.url ?? null, country: null };
  }
  const ats = ATS[prefix];
  if (ats && rest) {
    return {
      name: row.company?.trim() || rest, kind: "ats", via: ats.label,
      url: ats.url ? ats.url(encodeURIComponent(rest)) : null, country: null,
    };
  }
  return { name: row.source, kind: "other", via: prefix || "Unknown", url: null, country: null };
}

/**
 * Дата з бази: ISO ('…T…Z', пише NextRole) або SQLite ('YYYY-MM-DD HH:MM:SS', UTC,
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

/** Будній день UTC: сканер NextRole ходить лише пн-пт. */
export function isScanDay(at: Date): boolean {
  const d = at.getUTCDay();
  return d >= 1 && d <= 5;
}

/**
 * Планові скани, що вже мали відбутися (03:00 UTC буднього дня + SCAN_GRACE_HOURS не пізніше
 * за now), від найсвіжішого. У суботу й неділю найсвіжіший п'ятничний; у понеділок до 06:00
 * теж п'ятничний.
 */
export function pastScanSlots(now: Date, count: number): number[] {
  const out: number[] = [];
  const slot = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), SCAN_HOUR_UTC));
  while (out.length < count) {
    if (isScanDay(slot) && slot.getTime() + SCAN_GRACE_HOURS * HOUR_MS <= now.getTime()) out.push(slot.getTime());
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

/** Сканер пропустив останній плановий скан: жодного запуску з того буднього 03:00 UTC. */
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
  /** Живі вакансії web3: сума по джерелах NextRole плюс наші. До злиття дублікатів між джерелами. */
  liveJobs: number;
  nextroleLiveJobs: number;
  companyLiveJobs: number;
  /** Джерела NextRole з вакансіями web3, які були хоч в одному з STALE_AFTER_SCANS останніх сканів. */
  activeSources: number;
  staleSources: number;
  /** Скільки всього джерел у кеші NextRole, і з web3, і без. */
  allNextroleSources: number;
  /** Останній скан NextRole: scan_runs, а якщо таблиця порожня, найсвіжіший fetched_at. */
  lastScan: LastScan;
  /** Сканер пропустив плановий будній скан (scannerMissed): тоді й джерела застигають, і причина в ньому. */
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
  const nextroleLiveJobs = sources.reduce((n, s) => n + s.liveJobs, 0);
  const first = rows[0];
  const scanAt = parseDbTime(first?.last_scan_at);
  const newest = sources.reduce<number | null>((m, s) => (s.newestAt !== null && (m === null || s.newestAt > m) ? s.newestAt : m), null);
  const lastScan: LastScan = scanAt !== null
    ? { at: scanAt, status: first?.last_scan_status ?? null }
    : newest !== null ? { at: newest, status: null } : null;
  return {
    liveJobs: nextroleLiveJobs + company.liveJobs,
    nextroleLiveJobs,
    companyLiveJobs: company.liveJobs,
    activeSources: sources.filter((s) => !s.stale).length,
    staleSources: sources.filter((s) => s.stale).length,
    allNextroleSources: Number(first?.all_sources) || 0,
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
