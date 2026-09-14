// Підбір до п'яти вакансій людині. Чисті функції: пул і профіль на вході, вибір на виході.
//
// Правила (задача E7, docs/specs/2026-09-12-crm-agents-design.md 5.6):
// - роль обов'язкова: хоч одна роль вакансії серед ролей людини;
// - місце: 'remote' → віддалені; 'city' → місто в локації; 'remote,city' → обидва, місто спершу;
// - зарплата м'яко: вакансія без зарплати не карається, та, що дотягує до мінімуму людини, іде вище;
// - свіжість: спершу опубліковані за 30 днів, новіші спершу; ще відкриті давніші (пул їх уже
//   відібрав, jobs.ts) лише добирають до п'яти, коли свіжих мало, і пояснення це каже;
// - одна вакансія на компанію, нічого з уже надісланого цій людині;
// - не більше однієї вакансії компанії (company_jobs_live), і лише з роллю людини.
import { ROLE_NAMES } from "./roles.js";
import type { RoleKey } from "../types.js";

export const DIGEST_SIZE = 5;
export const MAX_COMPANY_JOBS = 1;
/** Скільки днів від публікації вакансія вважається свіжою. */
export const FRESH_DAYS = 30;
const DAY_MS = 86_400_000;

/**
 * 'nextrole' = вакансія зі сканування (база вакансій NextCryptoJob), 'company' = вакансія компанії.
 * Назва першої мітки з часів, коли вакансії читались з бази NextRole: вона збережена в sent.source
 * (CHECK у db/migrations/0006_digest.sql) і в контракті листа, тож не міняється.
 */
export type JobSource = "nextrole" | "company";

export interface JobSalary {
  min: number | null;
  max: number | null;
  /** ISO 4217, верхній регістр. */
  currency: string | null;
  period: "year" | "month";
}

/** Вакансія в пулі добірки, з будь-якого джерела. */
export interface DigestJob {
  /** Ключ у `sent.job_ref`: 'nr:<jobs_cache.id>' або 'co:<company_jobs.id>'. */
  ref: string;
  source: JobSource;
  id: string;
  title: string;
  company: string;
  /** Для правила «одна на компанію». */
  companyKey: string;
  url: string;
  /** Локація як її показати людині. */
  location: string | null;
  /** Текст, у якому шукати місто (локація зі сканування або місто вакансії компанії). */
  placeText: string | null;
  remote: boolean;
  /** Країна національної дошки (jobs_cache.country); такі не йдуть у «віддалено». Крипто-джерела лишають NULL. */
  country: string | null;
  salary: JobSalary | null;
  /** Мс від епохи; null, якщо джерело дату не дало. */
  postedAt: number | null;
  /** Коли скан побачив вакансію вперше (мс): вік вакансії без дати публікації. null для вакансій компаній. */
  firstSeenAt: number | null;
  /** Коли джерело бачило вакансію востаннє (мс); остання запасна дата свіжості. */
  seenAt: number | null;
  /** Ключ змісту зі сканування (компанія + роль): та сама вакансія під новою адресою. */
  dedupeKey: string | null;
  roles: RoleKey[];
}

export interface DigestProfile {
  roles: RoleKey[];
  /** users.remote_mode: 'remote' | 'city' | 'remote,city'. */
  remoteMode: string | null;
  city: string | null;
  salaryMin: number | null;
  salaryCurrency: string | null;
}

export interface DigestPick {
  job: DigestJob;
  /** Роль людини, за якою вакансія потрапила в добірку. */
  role: RoleKey;
  place: "remote" | "city";
  /** true дотягує до мінімуму, false нижче, null невідомо (немає зарплати або мінімуму). */
  meetsSalary: boolean | null;
  why: string;
}

export interface SelectOptions {
  now: Date;
  /** `sent.job_ref`, уже надіслані цій людині (будь-який статус). */
  exclude: ReadonlySet<string>;
  limit?: number;
}

// ---------------- місце ----------------

export function workModes(remoteMode: string | null | undefined): Array<"remote" | "city"> {
  const parts = (remoteMode ?? "").split(",").map((p) => p.trim().toLowerCase());
  return (["remote", "city"] as const).filter((m) => parts.includes(m));
}

/** Нижній регістр без діакритики й розділових знаків: «São Paulo» → «sao paulo». */
export function foldText(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Інші назви того самого міста, що трапляються в локаціях вакансій. */
const CITY_ALIASES: Record<string, string[]> = {
  "new york": ["nyc", "new york city", "manhattan", "brooklyn"],
  "san francisco": ["sf", "bay area", "san francisco bay area"],
  "los angeles": ["la"],
  kyiv: ["kiev"],
  munich: ["munchen", "muenchen"],
  lisbon: ["lisboa"],
  prague: ["praha"],
  warsaw: ["warszawa"],
  vienna: ["wien"],
  zurich: ["zuerich"],
  cologne: ["koln", "koeln"],
  bengaluru: ["bangalore"],
  "hong kong": ["hk"],
  "ho chi minh city": ["ho chi minh", "saigon", "hcmc"],
  "mexico city": ["cdmx", "ciudad de mexico"],
};

/** Усі написання міста людини, згорнуті foldText. */
export function cityVariants(city: string): string[] {
  // «Paris, France» → «paris»: людина могла дописати країну.
  const base = foldText(city.split(",")[0] ?? "");
  if (!base) return [];
  const out = new Set([base]);
  for (const [canon, aliases] of Object.entries(CITY_ALIASES)) {
    if (canon === base || aliases.includes(base)) { out.add(canon); for (const a of aliases) out.add(a); }
  }
  return [...out];
}

/** Чи згадує текст локації місто цілим словом (без регістру й діакритики). */
export function mentionsCity(text: string | null, city: string | null): boolean {
  if (!text || !city) return false;
  const hay = ` ${foldText(text)} `;
  return cityVariants(city).some((v) => hay.includes(` ${v} `));
}

const REMOTE_WORDS = /\b(remote|anywhere|worldwide|work from home|wfh|distributed|fully remote)\b/i;
const OFFICE_WORDS = /\b(hybrid|on-?site|in-?office|office based|office-based)\b/i;

/**
 * Віддалена вакансія зі сканування: прапорець джерела або слова в локації. «Hybrid» чи
 * «On-site» без слова «remote» перемагають прапорець: 12.09 у кеші був
 * remote = 1 з локацією «New York - Hybrid».
 */
export function isRemoteLocation(remoteFlag: boolean, location: string | null): boolean {
  const text = location ?? "";
  if (OFFICE_WORDS.test(text) && !/\bremote\b/i.test(text)) return false;
  return remoteFlag || REMOTE_WORDS.test(text);
}

/** Як вакансія підходить за місцем: 'city', 'remote' або null (не підходить). Місто важливіше. */
export function placeMatch(job: DigestJob, modes: ReadonlyArray<"remote" | "city">, city: string | null): "remote" | "city" | null {
  if (modes.includes("city") && city && mentionsCity(job.placeText, city)) return "city";
  // Національна дошка (country не null) = «віддалено в межах цієї країни»; країни людини ми не знаємо.
  if (modes.includes("remote") && job.remote && !(job.source === "nextrole" && job.country)) return "remote";
  return null;
}

// ---------------- зарплата ----------------

/** Грубо в долари: лише три валюти анкети (web/src/lib/onboarding/place.ts). Решта = невідомо. */
const USD_RATE: Record<string, number> = { USD: 1, EUR: 1.08, GBP: 1.27 };

/** Річна сума лише в правдоподібних межах: 1 000 у вилці це заглушка, а не зарплата. */
const MIN_ANNUAL = 10_000;
const MAX_ANNUAL = 5_000_000;

const plausibleAnnual = (v: number | null): v is number => typeof v === "number" && v >= MIN_ANNUAL && v <= MAX_ANNUAL;

/** Межі річної зарплати у валюті вакансії; null, якщо невідомо або неправдоподібно. */
export function annualRange(s: JobSalary | null): { min: number | null; max: number | null } | null {
  if (!s) return null;
  const k = s.period === "month" ? 12 : 1;
  const min = s.min === null ? null : s.min * k;
  const max = s.max === null ? null : s.max * k;
  const okMin = plausibleAnnual(min) ? min : null;
  const okMax = plausibleAnnual(max) ? max : null;
  if (okMin === null && okMax === null) return null;
  return { min: okMin, max: okMax };
}

export function toUsd(amount: number, currency: string | null): number | null {
  const rate = currency ? USD_RATE[currency.toUpperCase()] : undefined;
  return rate === undefined ? null : amount * rate;
}

/**
 * Чи дотягує вакансія до мінімуму людини. null, коли порівняти нема з чим (немає
 * мінімуму, немає зарплати, незнайома валюта): відсутність даних не є «нижче».
 */
export function meetsFloor(job: DigestJob, floor: number | null, floorCurrency: string | null): boolean | null {
  if (!floor || floor <= 0) return null;
  const range = annualRange(job.salary);
  if (!range) return null;
  const top = range.max ?? range.min!;
  const jobUsd = toUsd(top, job.salary!.currency);
  const floorUsd = toUsd(floor, floorCurrency ?? "USD");
  if (jobUsd === null || floorUsd === null) return null;
  return jobUsd >= floorUsd;
}

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

function money(n: number, currency: string | null): string {
  const k = n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
  const cur = (currency ?? "").toUpperCase();
  const sym = SYMBOL[cur];
  return sym ? `${sym}${k}` : cur ? `${cur} ${k}` : k;
}

/** «$120k to $150k», «from $120k», «up to €90k», «$8k to $10k a month»; null, якщо показати нічого. */
export function formatSalary(s: JobSalary | null): string | null {
  if (!annualRange(s)) return null;
  const { min, max, currency, period } = s!;
  const k = period === "month" ? 12 : 1;
  const okMin = min !== null && plausibleAnnual(min * k) ? min : null;
  const okMax = max !== null && plausibleAnnual(max * k) ? max : null;
  const tail = period === "month" ? " a month" : "";
  if (okMin !== null && okMax !== null && okMax > okMin) return `${money(okMin, currency)} to ${money(okMax, currency)}${tail}`;
  if (okMin !== null) return `from ${money(okMin, currency)}${tail}`;
  return `up to ${money(okMax!, currency)}${tail}`;
}

// ---------------- пояснення ----------------

/** Місто, як його ввела людина, без країни після коми. */
const cityLabel = (city: string): string => (city.split(",")[0] ?? city).trim();

/** Від якої дати вакансії вік: публікація, без неї перша поява в скані, без неї остання. */
export function ageFrom(job: DigestJob): number | null {
  return job.postedAt ?? job.firstSeenAt ?? job.seenAt;
}

/** Чи вакансія свіжа: опублікована (без дати: вперше побачена) за FRESH_DAYS. */
export function isFresh(job: DigestJob, now: Date): boolean {
  const at = ageFrom(job);
  if (at === null) return false;
  return now.getTime() - at <= FRESH_DAYS * DAY_MS;
}

/**
 * «Still open, posted 6 weeks ago.» для вакансії зі сканування, давнішої за FRESH_DAYS; null для
 * свіжої і для вакансії компанії. Без дати публікації кажемо, коли її вперше побачили, а не «posted».
 */
export function stillOpenNote(job: DigestJob, now: Date): string | null {
  if (job.source !== "nextrole" || isFresh(job, now)) return null;
  const at = ageFrom(job);
  if (at === null) return null;
  // Давніша за FRESH_DAYS = щонайменше 4 тижні, тож завжди «weeks».
  const weeks = Math.floor((now.getTime() - at) / (7 * DAY_MS));
  return `Still open, ${job.postedAt !== null ? "posted" : "first seen"} ${weeks} weeks ago.`;
}

/**
 * Рядок «чому ця вакансія», англійською, детерміновано, без довгого тире:
 * "Matches your Security auditor role. Remote. Salary listed: $120k to $150k."
 * З `now` давніша за FRESH_DAYS вакансія ще й каже, що вона досі відкрита і коли опублікована.
 */
export function whyLine(pick: Omit<DigestPick, "why">, profile: DigestProfile, now?: Date): string {
  const parts = [`Matches your ${ROLE_NAMES[pick.role]} role.`];
  parts.push(pick.place === "city" && profile.city ? `In ${cityLabel(profile.city)}.` : "Remote.");
  const salary = formatSalary(pick.job.salary);
  if (salary) parts.push(pick.meetsSalary ? `Salary listed: ${salary}, meets your minimum.` : `Salary listed: ${salary}.`);
  const open = now ? stillOpenNote(pick.job, now) : null;
  if (open) parts.push(open);
  return parts.join(" ").replace(/\u2014/g, "-");
}

// ---------------- відбір ----------------

type Candidate = Omit<DigestPick, "why"> & { fresh: boolean; key: [number, number, number, number, string] };

/** Менший ключ = вище: свіжа перед давнішою, місто перед віддаленим (коли обидва), зарплата, свіжість, ref. */
function rankKey(place: "remote" | "city", meets: boolean | null, job: DigestJob, bothModes: boolean, fresh: boolean): Candidate["key"] {
  const placeTier = bothModes && place === "remote" ? 1 : 0;
  // Дотягує 0, невідомо 1, нижче 2: відсутня зарплата ніколи не нижча за відому погану.
  const salaryTier = meets === true ? 0 : meets === null ? 1 : 2;
  return [fresh ? 0 : 1, placeTier, salaryTier, -(ageFrom(job) ?? 0), job.ref];
}

function compareKeys(a: Candidate["key"], b: Candidate["key"]): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3] || (a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : 0);
}

function candidatesFor(pool: readonly DigestJob[], profile: DigestProfile, o: SelectOptions, excludedDedupe: ReadonlySet<string>): Candidate[] {
  const modes = workModes(profile.remoteMode);
  // Місце не задано: віддалено, бо лише це не вимагає міста.
  const effectiveModes: ReadonlyArray<"remote" | "city"> = modes.length ? modes : ["remote"];
  const both = effectiveModes.includes("remote") && effectiveModes.includes("city") && !!profile.city;
  const out: Candidate[] = [];
  for (const job of pool) {
    if (o.exclude.has(job.ref)) continue;
    if (job.dedupeKey && excludedDedupe.has(job.dedupeKey)) continue;
    const role = profile.roles.find((r) => job.roles.includes(r));
    if (!role) continue;
    const place = placeMatch(job, effectiveModes, profile.city);
    if (!place) continue;
    // Живе все, що в пулі (jobs.ts); 30 днів лише ділять вакансії зі сканування на свіжі й давніші.
    // Вакансії компаній живуть, поки відкриті й оплачені (company_jobs_live), і завжди свіжі.
    const fresh = job.source !== "nextrole" || isFresh(job, o.now);
    const meets = meetsFloor(job, profile.salaryMin, profile.salaryCurrency);
    out.push({ job, role, place, meetsSalary: meets, fresh, key: rankKey(place, meets, job, both, fresh) });
  }
  return out.sort((a, b) => compareKeys(a.key, b.key));
}

/**
 * До `limit` вакансій. Вакансія компанії (не більше однієї) іде першою; решту
 * набираємо по колу за ролями людини (найкраща для першої ролі, для другої, …),
 * щоб друга роль не зникала за першою: спершу лише зі свіжих (FRESH_DAYS), і лише
 * якщо їх не вистачило до `limit`, так само з ще відкритих давніших. Показ у порядку
 * ключа ранжування: давніші завжди після свіжих.
 */
export function selectJobs(
  pool: { crawl: readonly DigestJob[]; company: readonly DigestJob[] },
  profile: DigestProfile,
  o: SelectOptions,
): DigestPick[] {
  const limit = o.limit ?? DIGEST_SIZE;
  if (profile.roles.length === 0 || limit <= 0) return [];

  // Та сама вакансія під новою адресою: ключ змісту вже надісланої, якщо вона ще в пулі.
  const excludedDedupe = new Set(
    pool.crawl.filter((j) => o.exclude.has(j.ref) && j.dedupeKey).map((j) => j.dedupeKey!),
  );

  const usedCompanies = new Set<string>();
  const usedDedupe = new Set<string>();
  const chosen: Candidate[] = [];
  const take = (c: Candidate): boolean => {
    if (usedCompanies.has(c.job.companyKey)) return false;
    if (c.job.dedupeKey && usedDedupe.has(c.job.dedupeKey)) return false;
    usedCompanies.add(c.job.companyKey);
    if (c.job.dedupeKey) usedDedupe.add(c.job.dedupeKey);
    chosen.push(c);
    return true;
  };

  const company = candidatesFor(pool.company, profile, o, excludedDedupe).filter((c) => c.job.source === "company");
  let companyTaken = 0;
  for (const c of company) {
    if (companyTaken >= MAX_COMPANY_JOBS || chosen.length >= limit) break;
    if (take(c)) companyTaken++;
  }
  const companyPicks = [...chosen];

  const crawl = candidatesFor(pool.crawl, profile, o, excludedDedupe).filter((c) => c.job.source === "nextrole");
  const byRoles = (list: Candidate[]): void => {
    const queues = profile.roles.map((r) => list.filter((c) => c.role === r));
    const cursor = queues.map(() => 0);
    while (chosen.length < limit) {
      let progressed = false;
      for (let q = 0; q < queues.length && chosen.length < limit; q++) {
        const queue = queues[q]!;
        while (cursor[q]! < queue.length) {
          const c = queue[cursor[q]!]!;
          cursor[q]!++;
          if (take(c)) { progressed = true; break; }
        }
      }
      if (!progressed) break;
    }
  };
  byRoles(crawl.filter((c) => c.fresh));
  byRoles(crawl.filter((c) => !c.fresh));

  const rest = chosen.slice(companyPicks.length).sort((a, b) => compareKeys(a.key, b.key));
  return [...companyPicks, ...rest].map(({ key: _key, fresh: _fresh, ...pick }) => ({ ...pick, why: whyLine(pick, profile, o.now) }));
}
