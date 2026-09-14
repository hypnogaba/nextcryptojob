// web3.career через їхній офіційний Web3 Jobs API (https://docs.bondex.app/api-reference) з токеном
// власника (WEB3CAREER_TOKEN). Сторінки сайту більше не читаються: той самий вміст дає API, а умови
// API ми прийняли.
//
// Умови API (лист власнику й рядок умов у самій відповіді API), обов'язкові, інакше доступ знімуть:
//   1. Вести людину на `apply_url` посиланням follow: без rel="nofollow" (і без ugc, sponsored).
//   2. `apply_url` не міняти: не додавати utm_source, utm_medium, ref чи будь-що; мітки вже всередині.
//   3. Токен лише наш і лише для нашого сайту; нікому, у жоден лог, у жоден коміт.
//   4. Називати web3.career джерелом вакансії («via web3.career»).
// Тому `apply_url` тут не проходить крізь жодну нормалізацію (cleanUrl, new URL().toString()): у
// базу йде рядок, який дав API. Ключ рядка (id) береться з номера вакансії на web3.career, а не з
// адреси, щоб мітки в адресі не множили рядки.
//
// Як читаємо (документація й живі відповіді 14.09.2026):
//   - GET https://web3.career/api/v1?token=…&limit=100[&tag=…][&country=…][&remote=true]
//   - сторінок немає: кожен запит дає до 100 найсвіжіших за своїм фільтром; тег один на запит;
//   - невідомий тег чи країна не помилка, а порожня відповідь;
//   - відповідь: масив, де два рядки-опис і вкладений масив вакансій (буває й масив вакансій одразу);
//   - з show_description=false API віддає урізані записи без id, компанії й тегів, тож беремо повні;
//   - ліміт запитів не названо, лише 429 при надмірі: запити по одному, пауза бюджету web3career
//     (limits.ts), 429 перечікуємо зростаючою паузою до 10 с, 401 і 403 не повторюємо.
import { fetchJson, type FetchOptions, SourceUnavailableError } from "../../http.js";
import { currencyCode, payFor, payPeriod, plausibleSalary, type Pay, yearly } from "../pay.js";
import type { BoardSource, RawJob, SalaryEstimate } from "../types.js";
import { isJunk } from "./boards.js";

export const WEB3CAREER_SOURCE = "board:web3career";
export const WEB3CAREER_TOKEN_ENV = "WEB3CAREER_TOKEN";
export const WEB3CAREER_API = "https://web3.career/api/v1";
/** Найбільше, що API віддає за запит. */
export const WEB3CAREER_LIMIT = 100;

/**
 * Теги, які API точно знає: перелік з документації (OpenAPI, enum `tag`) плюс теги, що стоять на
 * живих вакансіях 14.09 (engineer, senior, executive, finance, legal …). Невідомий тег API мовчки
 * перетворює на порожню відповідь, тож запит з тегом поза цим списком скан не шле (тест звіряє).
 */
export const WEB3CAREER_TAGS: ReadonlySet<string> = new Set([
  // документація
  "ai", "analyst", "backend", "bitcoin", "blockchain", "community-manager", "crypto", "cryptography", "cto",
  "customer-support", "dao", "data-science", "defi", "design", "developer-relations", "devops", "discord",
  "economy-designer", "entry-level", "erc", "erc-20", "evm", "front-end", "full-stack", "gaming", "ganache", "golang",
  "hardhat", "intern", "java", "javascript", "layer-2", "marketing", "mobile", "moderator", "nft", "node", "non-tech",
  "open-source", "openzeppelin", "pay-in-crypto", "product-manager", "project-manager", "react", "refi", "research",
  "ruby", "rust", "sales", "smart-contract", "solana", "solidity", "truffle", "web3-py", "web3js", "zero-knowledge",
  "security", "python", "typescript", "ethereum", "polkadot",
  // живі вакансії 14.09
  "engineer", "senior", "executive", "finance", "legal", "compliance", "hr", "recruiter", "operations", "growth",
  "business-development", "social-media", "ambassador", "kol", "trader",
]);

export type Web3CareerQuery = { tag?: string; country?: string; remote?: "true" };

/** Країни зі свіжими вакансіями 14.09, крім США: 100 найсвіжіших кожної сягають далі за 30 днів. */
const COUNTRIES = [
  "united-kingdom", "hong-kong", "taiwan", "united-arab-emirates", "canada", "bulgaria", "philippines", "china",
  "india", "poland", "mexico", "singapore", "argentina",
] as const;

/**
 * Запити одного скану, по одному, раз на добу (51 запит). Виміряно 14.09: за 30 днів у API близько
 * 380 різних вакансій; без фільтра 100 найсвіжіших сягають лише 16 днів, тож решту вікна добираємо
 * зрізами, кожен з яких або сягає далі 30 днів, або ділить густий зріз ще раз:
 */
export const WEB3CAREER_QUERIES: readonly Web3CareerQuery[] = [
  // найсвіжіші загалом (16 днів) і всі віддалені (48 днів)
  {}, { remote: "true" },
  // США дають 60% вакансій: 100 без тегу сягають 12 днів, тож США ділимо тегами
  ...["crypto", "blockchain", "non-tech", "engineer", "senior", "executive", "defi"].map((tag) => ({ country: "united-states", tag })),
  ...COUNTRIES.map((country) => ({ country })),
  // широкі теги по всіх країнах (16 до 21 дня)
  { tag: "crypto" }, { tag: "blockchain" }, { tag: "non-tech" },
  // ролі, яких бракує в пулі: DevRel, Community (і модератори), Creator / KOL, Trader, Security
  { tag: "developer-relations" }, { tag: "community-manager" }, { tag: "moderator" }, { tag: "discord" },
  { tag: "social-media" }, { tag: "ambassador" }, { tag: "kol" }, { tag: "marketing" }, { tag: "growth" },
  { tag: "trader" }, { tag: "security" }, { tag: "smart-contract" },
  // решта ролей добірки
  { tag: "research" }, { tag: "analyst" }, { tag: "design" }, { tag: "product-manager" }, { tag: "sales" },
  { tag: "business-development" }, { tag: "finance" }, { tag: "legal" }, { tag: "compliance" }, { tag: "hr" },
  { tag: "recruiter" }, { tag: "customer-support" }, { tag: "operations" },
];

/** Адреса одного запиту. Токен лише тут; назовні адреса йде тільки через redact (http.ts). */
export function web3CareerUrl(token: string, q: Web3CareerQuery): string {
  const p = new URLSearchParams({ token, limit: String(WEB3CAREER_LIMIT) });
  if (q.tag) p.set("tag", q.tag);
  if (q.country) p.set("country", q.country);
  if (q.remote) p.set("remote", q.remote);
  return `${WEB3CAREER_API}?${p.toString()}`;
}

/** Опис запиту для журналу й помилок: фільтри без токена. */
export const queryLabel = (q: Web3CareerQuery): string =>
  Object.entries(q).map(([k, v]) => `${k}=${v}`).join("&") || "latest";

/** Вакансія, як її віддає API (поля з живої відповіді 14.09; документація описує частину з них). */
export interface Web3CareerJob {
  id?: number | string;
  date?: string;
  date_epoch?: number;
  is_remote?: boolean;
  country?: string | null;
  city?: string | null;
  title?: string;
  company?: string;
  location?: string | null;
  apply_url?: string;
  tags?: unknown;
  salary_min_value?: string | number | null;
  salary_max_value?: string | number | null;
  salary_currency?: string | null;
  salary_unit?: string | null;
  /** Оцінка самого web3.career, а не слово роботодавця: у вилку не йде. */
  estimated_min_salary?: number | null;
  estimated_max_salary?: number | null;
  description?: string | null;
}

/**
 * Вакансії з відповіді. Документація просить не покладатись на форму: шукаємо перший вкладений
 * масив, інакше сам корінь, якщо в ньому об'єкти. Інша форма = збій джерела, а не нуль вакансій.
 */
export function extractJobs(body: unknown): Web3CareerJob[] {
  if (!Array.isArray(body)) throw new SourceUnavailableError("web3.career API: відповідь не масив");
  const nested = body.find((x) => Array.isArray(x));
  if (Array.isArray(nested)) return nested.filter(isObject) as Web3CareerJob[];
  if (body.length === 0) return [];
  if (body.every((x) => typeof x === "string")) return []; // лише рядки-опис: вакансій немає
  if (body.some(isObject)) return body.filter(isObject) as Web3CareerJob[];
  throw new SourceUnavailableError("web3.career API: у відповіді немає масиву вакансій");
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === "object" && x !== null && !Array.isArray(x);

const decode = (v: string): string =>
  v.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
   .replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ");

const text = (v: unknown, max: number): string =>
  typeof v === "string" ? decode(v).replace(/\s+/g, " ").trim().slice(0, max) : "";

const num = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * Вилка з полів роботодавця. Правила ті самі, що в ATS (pay.ts): період зі `salary_unit`
 * (YEAR, MONTH, HOUR), без періоду сума лише тоді річна, коли правдоподібна як річна. Валюта
 * без коду = USD: форма подачі на web3.career приймає лише долари (їхня розмітка JobPosting на
 * тих самих вакансіях пише USD). `estimated_*` не беремо: це здогад дошки, а не пропозиція.
 */
export function web3CareerPay(j: Web3CareerJob): Pay {
  const lo = num(j.salary_min_value);
  const hi = num(j.salary_max_value);
  if (lo === null && hi === null) return { salaryMin: null, salaryMax: null, salaryCurrency: null };
  const currency = currencyCode(j.salary_currency) ?? "USD";
  return payFor(lo, hi, currency, payPeriod(j.salary_unit));
}

/**
 * Оцінка web3.career (`estimated_min_salary`/`max`), річна, у доларах (так її показує їхній сайт).
 * Лише для вакансії без вилки роботодавця і лише правдоподібна як річна; інакше null. Іде в
 * salary_est_* окремо від вилки й показується з підписом «web3.career estimate».
 */
export function web3CareerEstimate(j: Web3CareerJob): SalaryEstimate | null {
  const pay = web3CareerPay(j);
  if (pay.salaryMin !== null || pay.salaryMax !== null) return null;
  const min = yearly(num(j.estimated_min_salary), "year");
  const max = yearly(num(j.estimated_max_salary), "year");
  if (min === null && max === null) return null;
  const currency = currencyCode(j.salary_currency) ?? "USD";
  return plausibleSalary(min, max, currency) ? { min, max, currency } : null;
}

function postedAt(j: Web3CareerJob): string | null {
  if (typeof j.date_epoch === "number" && Number.isFinite(j.date_epoch) && j.date_epoch > 0) {
    return new Date(j.date_epoch * 1000).toISOString();
  }
  const t = typeof j.date === "string" ? Date.parse(j.date) : NaN;
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

const REMOTE = /\b(remote|anywhere|worldwide|distributed)\b/i;

/** Запис API → вакансія скану. `url` = `apply_url` рядком, як його дав API, без жодної правки. */
export function parseWeb3Career(jobs: readonly Web3CareerJob[], board: Pick<BoardSource, "name" | "cryptoOnly">): RawJob[] {
  const out: RawJob[] = [];
  for (const j of jobs) {
    const url = typeof j.apply_url === "string" ? j.apply_url : "";
    const title = text(j.title, 300);
    const company = text(j.company, 120);
    if (!/^https:\/\/\S+$/i.test(url) || !title || !company) continue;
    if (isJunk(title, url) || isJunk(company, "")) continue;
    const location = text(j.location, 200) || null;
    const id = typeof j.id === "number" || (typeof j.id === "string" && /^\d+$/.test(j.id)) ? String(j.id) : null;
    const tags = Array.isArray(j.tags) ? j.tags.filter((t): t is string => typeof t === "string").slice(0, 40) : [];
    out.push({
      url,
      // Номер вакансії на web3.career: той самий рядок, навіть якщо мітки в apply_url зміняться.
      ...(id ? { idKey: `web3career:${id}` } : {}),
      company, title, location,
      remote: j.is_remote === true || REMOTE.test(location ?? ""),
      postedAt: postedAt(j),
      source: board.name,
      crypto: board.cryptoOnly,
      ...web3CareerPay(j),
      salaryEstimate: web3CareerEstimate(j),
      boardTags: tags,
      // Опис лише для вилки з тексту (salary-text.ts), у базу не йде. Обірваний тег у кінці теж геть.
      description: typeof j.description === "string"
        ? decode(j.description.replace(/<[^>]*>/g, " ").replace(/<[^>]*$/, " ")).replace(/\s+/g, " ").trim().slice(0, 20_000) || null
        : null,
    });
  }
  return out;
}

/** Параметри запитів до API: повтори й паузи з їхніх Best Practices (1 с, удвічі, стеля 10 с, 3 спроби). */
const API_FETCH: FetchOptions = { retries: 3, retryDelayMs: 1_000, maxBackoffMs: 10_000, timeoutMs: 30_000 };

/** Прибирає значення токена з будь-якого тексту: http.ts уже маскує `token=` в адресах, це запобіжник. */
export function hideToken(message: string, token: string): string {
  if (!token) return message;
  return message.split(token).join("***").split(encodeURIComponent(token)).join("***");
}

export interface Web3CareerUsage { requests: number; empty: number; failed: number; jobs: number }

/**
 * Усі запити скану по черзі (бюджет web3career у limits.ts тримає паузу між ними). Одна вакансія
 * з кількох зрізів лишається одна (за номером). 401/403 (токен) і 429 після повторів зупиняють
 * джерело; інший збій окремого зрізу пропускається, а якщо впали всі, падає джерело.
 */
export async function fetchWeb3Career(token: string | undefined, board: Pick<BoardSource, "name" | "cryptoOnly">,
                                      o: FetchOptions = {}, queries: readonly Web3CareerQuery[] = WEB3CAREER_QUERIES,
                                      usage?: Web3CareerUsage): Promise<RawJob[]> {
  const key = token?.trim();
  if (!key) throw new Error(`немає ${WEB3CAREER_TOKEN_ENV}: токен Web3 Jobs API (engine/deploy/README.md §8)`);
  const seen = new Map<string, RawJob>();
  const stats: Web3CareerUsage = usage ?? { requests: 0, empty: 0, failed: 0, jobs: 0 };
  let firstError: SourceUnavailableError | null = null;
  for (const q of queries) {
    let jobs: RawJob[];
    stats.requests++;
    try {
      jobs = parseWeb3Career(extractJobs(await fetchJson<unknown>(web3CareerUrl(key, q), {}, { ...API_FETCH, ...o })), board);
    } catch (e) {
      const status = e instanceof SourceUnavailableError ? e.status : undefined;
      const err = new SourceUnavailableError(`web3.career API (${queryLabel(q)}): ${hideToken(e instanceof Error ? e.message : String(e), key)}`, status);
      stats.failed++;
      // Токен не прийнято: решта запитів відповіла б так само.
      if (status === 401 || status === 403) throw err;
      // Попросили пригальмувати: не добиваємо, беремо зібране (нічого не зібрали = 429 джерела).
      if (status === 429) { if (seen.size === 0) throw err; break; }
      firstError ??= err;
      continue;
    }
    if (jobs.length === 0) stats.empty++;
    for (const j of jobs) {
      const k = j.idKey ?? j.url;
      if (!seen.has(k)) seen.set(k, j);
    }
  }
  if (firstError && stats.failed === stats.requests) throw firstError;
  stats.jobs = seen.size;
  return [...seen.values()];
}
