import { sqlTime } from "@/lib/time";

/**
 * Власний лічильник відвідувань (таблиці visit_days і visit_visitors, 0021). Без сторонніх
 * скриптів і без кук: перегляд рахує /api/me, який шапка сайту й так питає на кожному переході
 * (components/site-state.tsx), тож окремого запиту немає.
 *
 * Що зберігаємо: день, групу сторінок (не адресу), хост, звідки прийшли (не адресу), і два
 * лічильники. Унікальний відвідувач = HMAC-SHA256 від (IP, User-Agent) з сіллю дня, яка сама
 * є HMAC від секрету Worker і дати. Сирі IP і агент не пишуться ніде, а хеші живуть до
 * наступного дня (щоденне прибирання стирає день, старший за вчора), тож потім відвідувача не
 * впізнати навіть із секретом.
 *
 * Не рахуємо: ботів (за User-Agent; до того ж більшість ботів не виконує JS), адмінку й
 * переглядів адміна, службові адреси (api, _next).
 *
 * Запис: один пакет D1 на перегляд. Перша інструкція (UPSERT у visit_days) сама дивиться, чи
 * відвідувач уже був сьогодні, друга (INSERT OR IGNORE у visit_visitors) запам'ятовує його.
 * D1 виконує пакет по черзі в одній транзакції, тож новий за день рахується рівно раз.
 * Ціна: 1 записаний рядок на перегляд + 1 для першого перегляду відвідувача за день
 * ($1 за мільйон рядків; 10 тис. переглядів на день ≈ 0,36 млн рядків на місяць).
 */

/** Групи сторінок: перший збіг виграє. null = не рахувати. */
const GROUPS: readonly [RegExp, string | null][] = [
  [/^\/(admin|api|_next|auth|mcp)(\/|$)/, null],
  [/^\/$/, "home"],
  [/^\/jobs(\/|$)/, "jobs"],
  [/^\/c\//, "card"],
  [/^\/company\/start(\/|$)/, "company_start"],
  [/^\/company(\/|$)/, "company"],
  [/^\/login(\/|$)/, "login"],
  [/^\/welcome(\/|$)/, "onboarding"],
  [/^\/profile(\/|$)/, "profile"],
  [/^\/(settings|account)(\/|$)/, "settings"],
  [/^\/(scoring|how-scoring-works)(\/|$)/, "scoring"],
  [/^\/agents(\/|$)/, "agents"],
  [/^\/intro\//, "intro"],
  [/^\/(privacy|terms)(\/|$)/, "legal"],
];

/** Людські назви груп для адмінки. */
export const GROUP_LABELS: Record<string, string> = {
  home: "Home",
  jobs: "Jobs",
  card: "Shared cards",
  company_start: "Company sign-up",
  company: "Company CRM and page",
  login: "Sign in",
  onboarding: "Onboarding brief",
  profile: "Profile",
  settings: "Settings and account",
  scoring: "How scoring works",
  agents: "Agents",
  intro: "Intro answers",
  legal: "Privacy and terms",
  other: "Other pages",
};

export function pathGroup(pathname: string): string | null {
  const path = pathname.split(/[?#]/)[0] || "/";
  if (!path.startsWith("/") || path.length > 300) return null;
  for (const [re, group] of GROUPS) if (re.test(path)) return group;
  return "other";
}

const BOT_UA =
  /bot\b|bot\/|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|headless|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|curl\/|wget|python|httpclient|go-http-client|axios|node-fetch|undici|scrapy|phantomjs|selenium|puppeteer|playwright|okhttp|java\//i;

export function isBot(userAgent: string | null | undefined): boolean {
  const ua = (userAgent ?? "").trim();
  return ua.length < 10 || BOT_UA.test(ua);
}

/** Звідки прийшли: '' = зі свого сайту, 'direct' = без referrer, інакше хост без 'www.'. */
export function refHost(referrer: string | null | undefined, ownHost: string | null): string {
  const raw = (referrer ?? "").trim();
  if (!raw) return "direct";
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return "direct";
  }
  host = host.replace(/^www\./, "");
  if (!host || !/^[a-z0-9.-]{1,100}$/.test(host)) return "direct";
  const own = (ownHost ?? "").toLowerCase().replace(/^www\./, "").split(":")[0];
  if (own && (host === own || host.endsWith(`.${own}`))) return "";
  // Короткі адреси соцмереж під назвою мережі.
  if (host === "t.co") return "x.com";
  if (host === "twitter.com") return "x.com";
  if (host === "t.me") return "telegram";
  return host;
}

export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

const encoder = new TextEncoder();

async function hmacHex(key: string | ArrayBuffer, data: string): Promise<string> {
  const raw = typeof key === "string" ? encoder.encode(key) : new Uint8Array(key);
  const k = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", k, encoder.encode(data));
  return Array.from(new Uint8Array(sig), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Хеш відвідувача за день: HMAC(сіль дня, IP + агент), перші 32 hex. Сіль дня = HMAC(секрет,
 * 'visits:' + день): завтра той самий відвідувач дає інший хеш, і дні не зв'язати між собою.
 */
export async function visitorHash(secret: string, day: string, ip: string, userAgent: string): Promise<string> {
  const salt = await hmacHex(secret, `visits:${day}`);
  return (await hmacHex(salt, `${ip}\n${userAgent}`)).slice(0, 32);
}

export interface VisitInput {
  pathname: string;
  /** document.referrer першого перегляду; для переходу всередині сайту не передається. */
  referrer?: string | null;
  /** Перехід усередині сайту (не перше завантаження сторінки). */
  internal: boolean;
  ip: string;
  userAgent: string;
  ownHost: string | null;
  secret: string;
  now?: Date;
}

export type VisitOutcome = "counted" | "bot" | "skipped";

/** Порахувати перегляд. Не кидає: лічильник не має ламати сторінку. */
export async function recordVisit(db: D1Database, v: VisitInput): Promise<VisitOutcome> {
  if (isBot(v.userAgent)) return "bot";
  const group = pathGroup(v.pathname);
  if (!group || !v.secret) return "skipped";
  const now = v.now ?? new Date();
  const day = utcDay(now);
  const ref = v.internal ? "" : refHost(v.referrer, v.ownHost);
  try {
    const hash = await visitorHash(v.secret, day, v.ip, v.userAgent);
    await db.batch([
      db
        .prepare(
          `INSERT INTO visit_days (day, path_group, ref_host, views, uniques)
           VALUES (?1, ?2, ?3, 1, NOT EXISTS (SELECT 1 FROM visit_visitors WHERE day = ?1 AND hash = ?4))
           ON CONFLICT (day, path_group, ref_host) DO UPDATE SET views = views + 1, uniques = uniques + excluded.uniques`,
        )
        .bind(day, group, ref, hash),
      db.prepare("INSERT OR IGNORE INTO visit_visitors (day, hash) VALUES (?, ?)").bind(day, hash),
    ]);
    return "counted";
  } catch (error) {
    console.error("visits: not counted", error instanceof Error ? error.message : String(error));
    return "skipped";
  }
}

// ---------------------------------------------------------------------------
// Звіт для адмінки

export type VisitDay = { day: string; views: number; uniques: number; signups: number };
export type VisitGroup = { key: string; views: number; uniques: number };

export interface VisitReport {
  days: VisitDay[];
  totals: { views: number; uniques: number; signups: number };
  /** Нові за день відвідувачі за групою сторінки, де вони з'явились уперше. */
  pages: VisitGroup[];
  /** Звідки прийшли (без переходів усередині сайту). */
  referrers: VisitGroup[];
  available: boolean;
  error: string | null;
}

const DAY_MS = 86_400_000;

/**
 * Останні `days` днів UTC разом із сьогоднішнім: відвідування з visit_days (діапазон за
 * первинним ключем) і реєстрації з users (без демо). Чотири інструкції одним пакетом.
 */
export async function loadVisits(db: D1Database, now: Date = new Date(), days = 30): Promise<VisitReport> {
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const from = utcDay(new Date(today - (days - 1) * DAY_MS));
  const to = utcDay(new Date(today));
  const unavailable = (error: string): VisitReport => ({
    days: [], totals: { views: 0, uniques: 0, signups: 0 }, pages: [], referrers: [], available: false, error,
  });
  let res: D1Result<Record<string, unknown>>[];
  try {
    res = await db.batch<Record<string, unknown>>([
      db
        .prepare("SELECT day, SUM(views) AS views, SUM(uniques) AS uniques FROM visit_days WHERE day BETWEEN ? AND ? GROUP BY day")
        .bind(from, to),
      db
        .prepare(
          `SELECT path_group AS key, SUM(views) AS views, SUM(uniques) AS uniques FROM visit_days
            WHERE day BETWEEN ? AND ? GROUP BY path_group ORDER BY uniques DESC, views DESC LIMIT 12`,
        )
        .bind(from, to),
      db
        .prepare(
          `SELECT ref_host AS key, SUM(views) AS views, SUM(uniques) AS uniques FROM visit_days
            WHERE day BETWEEN ? AND ? AND ref_host <> '' GROUP BY ref_host ORDER BY uniques DESC, views DESC LIMIT 12`,
        )
        .bind(from, to),
      db
        .prepare(
          `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users
            WHERE created_at >= ? AND is_demo = 0 GROUP BY day`,
        )
        .bind(sqlTime(new Date(`${from}T00:00:00Z`))),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such (table|column)/i.test(message)) return unavailable("Visit counting starts after migration 0021 is applied.");
    throw error;
  }
  const num = (v: unknown) => Number(v) || 0;
  const visits = new Map(res[0].results.map((r) => [String(r.day), r]));
  const signups = new Map(res[3].results.map((r) => [String(r.day), num(r.n)]));
  const list: VisitDay[] = Array.from({ length: days }, (_, i) => {
    const day = utcDay(new Date(today - i * DAY_MS));
    const r = visits.get(day);
    return { day, views: num(r?.views), uniques: num(r?.uniques), signups: signups.get(day) ?? 0 };
  });
  const group = (rows: Record<string, unknown>[]): VisitGroup[] =>
    rows.map((r) => ({ key: String(r.key), views: num(r.views), uniques: num(r.uniques) }));
  return {
    days: list,
    totals: list.reduce(
      (t, d) => ({ views: t.views + d.views, uniques: t.uniques + d.uniques, signups: t.signups + d.signups }),
      { views: 0, uniques: 0, signups: 0 },
    ),
    pages: group(res[1].results),
    referrers: group(res[2].results),
    available: true,
    error: null,
  };
}

/** Частка переходу «відвідав → зареєструвався», текстом: «3.2%» або «n/a». */
export function conversion(signups: number, uniques: number): string {
  if (uniques <= 0) return signups > 0 ? "n/a" : "0%";
  const p = (100 * signups) / uniques;
  return `${p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

// ---------------------------------------------------------------------------
// Графік: та сама таблиця, але зібрана по днях, тижнях або місяцях

export const VISIT_BUCKETS = ["day", "week", "month"] as const;
export type VisitBucket = (typeof VISIT_BUCKETS)[number];

export function isVisitBucket(raw: unknown): raw is VisitBucket {
  return typeof raw === "string" && (VISIT_BUCKETS as readonly string[]).includes(raw);
}

/**
 * Скільки стовпчиків показуємо: 30 днів, 12 тижнів, 12 місяців. visit_days має ~11 рядків
 * на добу (група сторінок × звідки прийшли), тож навіть рік це ~4 тис. читань на показ.
 */
export const BUCKET_COUNT: Record<VisitBucket, number> = { day: 30, week: 12, month: 12 };

const BUCKET_LABEL: Record<VisitBucket, string> = { day: "day", week: "week", month: "month" };
export const bucketLabel = (b: VisitBucket): string => BUCKET_LABEL[b];

const MONTH_NAME = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" });
const DAY_NAME = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Один стовпчик графіка. `from`/`to` включно, днями UTC. */
export type VisitPoint = {
  key: string;
  /** Підпис під стовпчиком: «Sep 17», «Sep 15» (тиждень з), «Sep». */
  label: string;
  /** Повна назва для підказки: «Week of Sep 15 - Sep 21». */
  title: string;
  from: string;
  to: string;
  views: number;
  uniques: number;
  signups: number;
};

export interface VisitSeries {
  bucket: VisitBucket;
  /** Найдавніший стовпчик перший: графік читається зліва направо. */
  points: VisitPoint[];
  totals: { views: number; uniques: number; signups: number };
  available: boolean;
  error: string | null;
}

const startOfUtcDay = (at: Date): number => Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
/** Понеділок того тижня, у якому цей день. */
const startOfUtcWeek = (ms: number): number => {
  const at = new Date(ms);
  const shift = (at.getUTCDay() + 6) % 7;
  return ms - shift * DAY_MS;
};

/** Межі стовпчиків, від найдавнішого до сьогоднішнього (останній може бути неповним). */
export function visitRanges(bucket: VisitBucket, now: Date): { from: string; to: string; label: string; title: string; key: string }[] {
  const today = startOfUtcDay(now);
  const out: { from: string; to: string; label: string; title: string; key: string }[] = [];
  const count = BUCKET_COUNT[bucket];
  if (bucket === "day") {
    for (let i = count - 1; i >= 0; i--) {
      const day = utcDay(new Date(today - i * DAY_MS));
      out.push({ key: day, from: day, to: day, label: DAY_NAME.format(today - i * DAY_MS), title: DAY_NAME.format(today - i * DAY_MS) });
    }
    return out;
  }
  if (bucket === "week") {
    const thisWeek = startOfUtcWeek(today);
    for (let i = count - 1; i >= 0; i--) {
      const start = thisWeek - i * 7 * DAY_MS;
      const end = start + 6 * DAY_MS;
      out.push({
        key: utcDay(new Date(start)),
        from: utcDay(new Date(start)),
        to: utcDay(new Date(end)),
        label: DAY_NAME.format(start),
        title: `Week of ${DAY_NAME.format(start)} to ${DAY_NAME.format(end)}`,
      });
    }
    return out;
  }
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  for (let i = count - 1; i >= 0; i--) {
    const start = Date.UTC(y, m - i, 1);
    const end = Date.UTC(y, m - i + 1, 0);
    const at = new Date(start);
    out.push({
      key: `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, "0")}`,
      from: utcDay(at),
      to: utcDay(new Date(end)),
      label: at.getUTCMonth() === 0 ? `${MONTH_NAME.format(start)} ${at.getUTCFullYear()}` : MONTH_NAME.format(start),
      title: `${MONTH_NAME.format(start)} ${at.getUTCFullYear()}`,
    });
  }
  return out;
}

/**
 * Відвідування й реєстрації для графіка. Два запити одним пакетом на весь проміжок, далі
 * складаємо в стовпчики тут (тижні з понеділка, місяці календарні): у SQL це або strftime
 * на кожен рядок, або окремий запит на стовпчик.
 */
export async function loadVisitSeries(db: D1Database, bucket: VisitBucket, now: Date = new Date()): Promise<VisitSeries> {
  const ranges = visitRanges(bucket, now);
  const from = ranges[0]!.from;
  const to = ranges[ranges.length - 1]!.to;
  const empty = (available: boolean, error: string | null): VisitSeries => ({
    bucket,
    points: ranges.map((r) => ({ ...r, views: 0, uniques: 0, signups: 0 })),
    totals: { views: 0, uniques: 0, signups: 0 },
    available,
    error,
  });
  let res: D1Result<Record<string, unknown>>[];
  try {
    res = await db.batch<Record<string, unknown>>([
      db
        .prepare("SELECT day, SUM(views) AS views, SUM(uniques) AS uniques FROM visit_days WHERE day BETWEEN ? AND ? GROUP BY day")
        .bind(from, to),
      db
        .prepare(
          `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users
            WHERE created_at >= ? AND created_at < ? AND is_demo = 0 GROUP BY day`,
        )
        .bind(sqlTime(new Date(`${from}T00:00:00Z`)), sqlTime(new Date(`${to}T23:59:59Z`))),
    ]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such (table|column)/i.test(message)) return empty(false, "Visit counting starts after migration 0021 is applied.");
    throw error;
  }
  const num = (v: unknown) => Number(v) || 0;
  const visits = new Map(res[0].results.map((r) => [String(r.day), r]));
  const signups = new Map(res[1].results.map((r) => [String(r.day), num(r.n)]));
  const points: VisitPoint[] = ranges.map((r) => {
    const point: VisitPoint = { ...r, views: 0, uniques: 0, signups: 0 };
    for (let ms = Date.parse(`${r.from}T00:00:00Z`); ms <= Date.parse(`${r.to}T00:00:00Z`); ms += DAY_MS) {
      const day = utcDay(new Date(ms));
      const v = visits.get(day);
      point.views += num(v?.views);
      point.uniques += num(v?.uniques);
      point.signups += signups.get(day) ?? 0;
    }
    return point;
  });
  return {
    bucket,
    points,
    totals: points.reduce(
      (t, p) => ({ views: t.views + p.views, uniques: t.uniques + p.uniques, signups: t.signups + p.signups }),
      { views: 0, uniques: 0, signups: 0 },
    ),
    available: true,
    error: null,
  };
}
