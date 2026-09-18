import { loadCompanyJobs } from "@/lib/crm/public-jobs";
import { cleanText, estimateText } from "@/lib/digest/format";
import type { RoleKey } from "@/lib/card/roles";
import type { JobsDb } from "@/lib/jobs-db";
import { type CompanyProfiles, companyProfiles, EMPTY_PROFILES, profileFor } from "./companies";
import { externalJobLink } from "./link";
import { formatSalary } from "./match";
import { FAILURE_BACKOFF_MS, crawlPool, POOL_TTL_MS, type PoolJob } from "./pool";
import { tokenChip, type TokenChip } from "./token";

/**
 * Табло головної: лічильники, приклад щоденного листа і стрічка вакансій із зарплатою.
 *
 * Жодного власного читання бази: усе рахується в пам'яті з того самого пулу, що бере
 * search_jobs і «Jobs for you now» (pool.ts, пам'ять ізолята POOL_TTL_MS), плюс
 * живі вакансії компаній (одне читання, не більше COMPANY_POOL_CAP рядків). Готове табло
 * теж живе в пам'яті ізолята POOL_TTL_MS, тож головна додає не більше одного читання
 * вакансій компаній на 10 хвилин. База вакансій не відповіла: available: false, і сторінка
 * показує запасний текст замість чисел (FAILURE_BACKOFF_MS до наступної спроби).
 */

const DAY_MS = 86_400_000;
/**
 * «New this week»: опубліковані за стільки днів; без дати публікації вперше побачені сканом за
 * стільки днів (вакансії компаній без дати новими не рахуються). Не за правилом «жива»: стара, але
 * ще відкрита вакансія не нова.
 */
export const NEW_WINDOW_DAYS = 7;
/** Скільки вакансій бере стрічка. */
export const TICKER_SIZE = 20;
/** Менше цього стрічка не рухається: коротка доріжка не заповнить широкий екран без дірки. */
export const TICKER_MIN_TO_SCROLL = 8;
/** Скільки вакансій у прикладі щоденного листа на головній: стільки, скільки шле добірка. */
export const TODAY_SIZE = 5;
/** Для кого приклад: найчисленніша роль, віддалено. */
export const TODAY_ROLE: RoleKey = "engineer";

export type HomeStats = {
  /**
   * Живих вакансій у пулі (зі сканування після сита + компаній): правило «жива вакансія», pool.ts.
   * Сюди входять і вакансії без нашої ролі в назві: вони теж наші живі вакансії, їх видно в списку
   * й дістають власні слова людини (власник 17.09).
   */
  live: number;
  /** Опубліковані (без дати: вперше побачені) за NEW_WINDOW_DAYS днів. */
  newThisWeek: number;
  /** Різних компаній (ключ компанії, як у правилі добірки «одна на компанію»). */
  companies: number;
  /** З зарплатою, яку ми показали б людині (formatSalary не null). */
  withSalary: number;
  /** Різних джерел: дошки зі сканування (jobs_cache.source) і, якщо є, вакансії компаній у нас. */
  sources: number;
  /** Найсвіжіше: коли скан востаннє бачив вакансію або компанія опублікувала свою (мс). */
  updatedMs: number | null;
};

/** Вакансія стрічки: лише з показною зарплатою і безпечним посиланням. */
export type TickerJob = {
  ref: string;
  title: string;
  company: string;
  place: string | null;
  /** Зарплата роботодавця («$120k to $150k») або, якщо `estimate`, оцінка дошки підписом. */
  salary: string;
  /** true: у `salary` оцінка дошки («est. … (web3.career estimate)»), показується приглушено. */
  estimate: boolean;
  /** Вакансія компанії: /jobs/<id> на сайті; зі сканування: http(s) адреса дошки рівно як у базі. */
  href: string;
  external: boolean;
  /** rel зовнішнього посилання (lib/jobs/link.ts); null для вакансій компаній. */
  rel: string | null;
  /** Кого назвати джерелом («web3.career»), або null. */
  via: string | null;
  /** Чип токена компанії (db/jobs 0004), лише свіжі ціни; null, якщо токена немає чи це вакансія компанії. */
  token: TokenChip | null;
};

/**
 * Приклад щоденного листа: TODAY_SIZE живих вакансій. `role` задано, коли всі вони для
 * TODAY_ROLE і віддалені (так і підписуємо); null, коли таких забракло і взято вакансії різних ролей.
 */
export type TodaysJobs = { role: RoleKey | null; jobs: TickerJob[] };

export type HomeBoard =
  | { available: true; stats: HomeStats; today: TodaysJobs; ticker: TickerJob[] }
  | { available: false; stats: null; today: null; ticker: [] };

const UNAVAILABLE: HomeBoard = { available: false, stats: null, today: null, ticker: [] };

// ---------------------------------------------------------------------------
// Лічильники

export function homeStats(crawl: readonly PoolJob[], company: readonly PoolJob[], now: Date): HomeStats {
  const all = [...crawl, ...company];
  const t = now.getTime();
  const since = t - NEW_WINDOW_DAYS * DAY_MS;
  const origins = new Set(crawl.map((j) => j.origin).filter((o): o is string => Boolean(o)));
  let updatedMs: number | null = null;
  for (const ms of [...crawl.map((j) => j.seenMs), ...company.map((j) => j.postedMs)]) {
    if (ms !== null && ms <= t && (updatedMs === null || ms > updatedMs)) updatedMs = ms;
  }
  return {
    live: all.length,
    newThisWeek: all.filter((j) => {
      const at = j.postedMs ?? j.firstSeenMs;
      return at !== null && at >= since && at <= t;
    }).length,
    companies: new Set(all.map((j) => j.companyKey)).size,
    withSalary: all.filter((j) => formatSalary(j.salary) !== null).length,
    sources: origins.size + (company.length > 0 ? 1 : 0),
    updatedMs,
  };
}

/** «just now», «12 min ago», «17 h ago», «3 days ago»: униз, як і числа. null без дати. */
export function updatedAgo(ms: number | null, now: number): string | null {
  if (ms === null) return null;
  const min = Math.max(0, Math.floor((now - ms) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.floor(h / 24)} days ago`;
}

// ---------------------------------------------------------------------------
// Стрічка

type TickerLink = { href: string; external: boolean; rel: string | null; via: string | null };

/**
 * Посилання стрічки: вакансія компанії веде на її сторінку в нас, сканована лише на http(s), і
 * адреса рівно та, що в базі (web3.career забороняє міняти apply_url; rel вирішує lib/jobs/link.ts).
 */
export function tickerHref(job: PoolJob): TickerLink | null {
  if (job.source === "company") return { href: `/jobs/${encodeURIComponent(job.jobId)}`, external: false, rel: null, via: null };
  const link = externalJobLink(job.url);
  if (!link || !/^https?:/i.test(link.href)) return null;
  return { href: link.href, external: true, rel: link.rel, via: link.via };
}

type Cand = { job: PoolJob; salary: string; estimate: boolean; link: TickerLink };

/**
 * Вакансії, які можна показати на головній, у порядку показу. Не беремо: без зарплати чи без
 * валюти («150k» без валюти нічого не каже), з кривим чи не http(s) посиланням, з національних
 * дощок (country: назви мовою країни). Вакансія лише з оцінкою дошки (web3.career) іде після всіх
 * із зарплатою роботодавця і показується підписом «est. … (web3.career estimate)».
 * Порядок: зарплата роботодавця перед оцінкою; новіші за датою публікації спершу; без дати після
 * всіх датованих (відсутнє значення не випереджає справжнє), серед них за першою появою в скані; далі за jobId.
 */
function candidates(all: readonly PoolJob[], withEstimates: boolean): Cand[] {
  const cands: Cand[] = [];
  for (const job of all) {
    if (job.country || job.roles.length === 0) continue;
    const link = tickerHref(job);
    if (!link) continue;
    const salary = job.salary?.currency ? formatSalary(job.salary) : null;
    if (salary) {
      cands.push({ job, salary, estimate: false, link });
      continue;
    }
    const est = withEstimates && !job.salary && job.salaryEstimate?.currency ? estimateText(job.salaryEstimate) : null;
    if (est) cands.push({ job, salary: est, estimate: true, link });
  }
  const at = (j: PoolJob) => j.postedMs ?? j.firstSeenMs ?? j.seenMs ?? 0;
  return cands.sort(
    (a, b) =>
      Number(a.estimate) - Number(b.estimate) ||
      Number(a.job.postedMs === null) - Number(b.job.postedMs === null) ||
      at(b.job) - at(a.job) ||
      (a.job.jobId < b.job.jobId ? -1 : a.job.jobId > b.job.jobId ? 1 : 0),
  );
}

/** Ключ вакансії на сторінці: co:<id> для вакансій компаній, nr:<id> для сканованих. */
const refOf = (j: PoolJob) => (j.source === "company" ? `co:${j.jobId}` : `nr:${j.jobId.replace(/^nr_/, "")}`);

/** Профіль компанії лише для вакансій зі сканування: у вакансії компанії є своя сторінка на сайті. */
function tokenOf(job: PoolJob, profiles: CompanyProfiles, now: Date): TokenChip | null {
  if (job.source !== "crawl") return null;
  return tokenChip(profileFor(profiles, job.companyKey, job.company)?.token, now);
}

function toTickerJob(c: Cand, profiles: CompanyProfiles, now: Date): TickerJob {
  return {
    ref: refOf(c.job),
    title: cleanText(c.job.title, 70),
    company: cleanText(c.job.company, 40),
    place: c.job.location ? cleanText(c.job.location, 36) : null,
    salary: c.salary,
    estimate: c.estimate,
    href: c.link.href,
    external: c.link.external,
    rel: c.link.rel,
    via: c.link.via,
    token: tokenOf(c.job, profiles, now),
  };
}

/**
 * До `size` вакансій із зарплатою для стрічки, одна на компанію, по черзі з різних ролей
 * (у кожній ролі найсвіжіші першими), щоб стрічка не була самими інженерами. Вакансія лише з
 * оцінкою дошки йде в чергу своєї ролі після всіх із зарплатою роботодавця: так роль без жодної
 * вилки (Community, Creator) не зникає зі стрічки, а оцінка ніколи не випереджає справжню зарплату.
 */
export function tickerJobs(
  all: readonly PoolJob[],
  size = TICKER_SIZE,
  profiles: CompanyProfiles = EMPTY_PROFILES,
  now: Date = new Date(),
): TickerJob[] {
  // Черги за першою роллю вакансії, у порядку, в якому роль уперше трапилась (найсвіжіша першою).
  const queues = new Map<string, Cand[]>();
  for (const c of candidates(all, true)) {
    const role = c.job.roles[0];
    const q = queues.get(role);
    if (q) q.push(c);
    else queues.set(role, [c]);
  }
  const used = new Set<string>();
  const out: TickerJob[] = [];
  let took = true;
  while (out.length < size && took) {
    took = false;
    for (const q of queues.values()) {
      while (q.length > 0 && used.has(q[0].job.companyKey)) q.shift();
      const c = q.shift();
      if (!c) continue;
      used.add(c.job.companyKey);
      took = true;
      out.push(toTickerJob(c, profiles, now));
      if (out.length >= size) break;
    }
  }
  return out;
}

/**
 * Приклад щоденного листа: TODAY_SIZE найсвіжіших віддалених вакансій для TODAY_ROLE із зарплатою
 * роботодавця (оцінку дошки сюди не беремо), одна на компанію. Якщо таких менше TODAY_SIZE,
 * беремо перші TODAY_SIZE зі стрічки (різні ролі) і role: null, щоб підпис не обіцяв інженера.
 */
export function todaysJobs(all: readonly PoolJob[], profiles: CompanyProfiles = EMPTY_PROFILES, now: Date = new Date()): TodaysJobs {
  const used = new Set<string>();
  const jobs: TickerJob[] = [];
  for (const c of candidates(all, false)) {
    if (!c.job.roles.includes(TODAY_ROLE) || !c.job.workMode.includes("remote") || used.has(c.job.companyKey)) continue;
    used.add(c.job.companyKey);
    jobs.push(toTickerJob(c, profiles, now));
    if (jobs.length === TODAY_SIZE) return { role: TODAY_ROLE, jobs };
  }
  return { role: null, jobs: tickerJobs(all, TODAY_SIZE, profiles, now) };
}

/** Приклад листа і стрічка без повторів: вакансії з прикладу в стрічку не йдуть. */
export function homeLists(
  all: readonly PoolJob[],
  profiles: CompanyProfiles = EMPTY_PROFILES,
  now: Date = new Date(),
): { today: TodaysJobs; ticker: TickerJob[] } {
  const today = todaysJobs(all, profiles, now);
  const shown = new Set(today.jobs.map((j) => j.ref));
  return { today, ticker: tickerJobs(all.filter((j) => !shown.has(refOf(j))), TICKER_SIZE, profiles, now) };
}

// ---------------------------------------------------------------------------
// Табло з кешем

let board: { at: number; value: HomeBoard } | null = null;

/** Для тестів: наступний виклик рахує знову. */
export function resetHomeBoard(): void {
  board = null;
}

/**
 * Кеш табло в краю Cloudflare (Cache API, без нових прив'язок): пам'ять ізолята живе лише поки живе
 * ізолят, а їх гасять часто, тож холодний ізолят інакше знову читає весь пул з D1 (1 до 2,4 с на
 * першому байті, замір 18.09). Тут табло спільне для всіх ізолятів однієї колонії.
 * Ключ з версією: міняй `v`, коли міняється форма HomeBoard, інакше старий запис прочитається як новий.
 */
const EDGE_KEY = "https://home-board.nextcryptojob.internal/v1";
/**
 * Скільки табло живе в краю. Скан оновлює базу раз на добу, тож числа можуть стояти годинами
 * (рішення власника 18.09: «цифру вакансій можна оновлювати раз на день»). Беремо годину, а не добу:
 * на швидкість це не впливає (ізолят живе хвилини), зате вакансія компанії, яка щойно заплатила,
 * потрапляє на головну за годину, а не за добу.
 */
export const EDGE_TTL_S = 3600;

/** Кеш краю або null (тести й будь-що поза Worker). */
function edgeCache(): Cache | null {
  try {
    const c = (globalThis as { caches?: { default?: Cache } }).caches;
    return c?.default ?? null;
  } catch {
    return null;
  }
}

/** Табло з краю, або null. Порожнє табло (available: false) не кешуємо й не читаємо. */
async function fromEdge(): Promise<HomeBoard | null> {
  const c = edgeCache();
  if (!c) return null;
  try {
    const hit = await c.match(EDGE_KEY);
    if (!hit) return null;
    const value = (await hit.json()) as HomeBoard;
    return value?.available ? value : null;
  } catch {
    return null;
  }
}

/** Кладе табло в край. Помилка кешу нічого не ламає: сторінка вже має значення. */
async function toEdge(value: HomeBoard): Promise<void> {
  const c = edgeCache();
  if (!c || !value.available) return;
  try {
    await c.put(
      EDGE_KEY,
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json", "cache-control": `max-age=${EDGE_TTL_S}` },
      }),
    );
  } catch {
    // Кеш краю не обов'язковий.
  }
}

export async function homeBoard(deps: {
  db: () => D1Database;
  env: { SITE_URL?: string };
  jobs: () => JobsDb;
  now: Date;
}): Promise<HomeBoard> {
  const t = Date.now();
  if (board && t - board.at < (board.value.available ? POOL_TTL_MS : FAILURE_BACKOFF_MS)) return board.value;
  const shared = await fromEdge();
  if (shared) {
    board = { at: Date.now(), value: shared };
    return shared;
  }
  let value: HomeBoard;
  try {
    const crawl = await crawlPool(deps.jobs, deps.now);
    if (!crawl) {
      value = UNAVAILABLE;
    } else {
      let company: PoolJob[] = [];
      try {
        company = await loadCompanyJobs(deps.db(), deps.env);
      } catch (e) {
        console.warn(`home: company jobs read failed (${e instanceof Error ? e.name : "unknown"})`);
      }
      const profiles = await companyProfiles(deps.jobs);
      value = { available: true, stats: homeStats(crawl, company, deps.now), ...homeLists([...company, ...crawl], profiles, deps.now) };
    }
  } catch (e) {
    // Напр. немає прив'язки DB поза Worker: головна однаково відкривається.
    console.warn(`home: live board failed (${e instanceof Error ? e.name : "unknown"})`);
    value = UNAVAILABLE;
  }
  board = { at: Date.now(), value };
  await toEdge(value);
  return value;
}
