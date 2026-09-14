import { loadCompanyJobs } from "@/lib/crm/public-jobs";
import { cleanText } from "@/lib/digest/format";
import type { JobsDb } from "@/lib/jobs-db";
import { formatSalary } from "./match";
import { FAILURE_BACKOFF_MS, crawlPool, POOL_TTL_MS, type PoolJob } from "./pool";

/**
 * Табло головної: лічильники й стрічка вакансій із зарплатою.
 *
 * Жодного власного читання бази: усе рахується в пам'яті з того самого пулу, що бере
 * search_jobs і «Jobs for you now» (pool.ts, пам'ять ізолята POOL_TTL_MS), плюс
 * живі вакансії компаній (одне читання, не більше COMPANY_POOL_CAP рядків). Готове табло
 * теж живе в пам'яті ізолята POOL_TTL_MS, тож головна додає не більше одного читання
 * вакансій компаній на 10 хвилин. База вакансій не відповіла: available: false, і сторінка
 * показує запасний текст замість чисел (FAILURE_BACKOFF_MS до наступної спроби).
 */

const DAY_MS = 86_400_000;
/** «New this week»: опубліковані за стільки днів. Без дати публікації вакансія новою не рахується. */
export const NEW_WINDOW_DAYS = 7;
/** Скільки вакансій бере стрічка. */
export const TICKER_SIZE = 20;
/** Менше цього стрічка не рухається: коротка доріжка не заповнить широкий екран без дірки. */
export const TICKER_MIN_TO_SCROLL = 8;

export type HomeStats = {
  /** Живих вакансій у пулі (зі сканування після сита + компаній). */
  live: number;
  /** Опубліковані за NEW_WINDOW_DAYS днів. */
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
  salary: string;
  /** Вакансія компанії: /jobs/<id> на сайті; зі сканування: http(s) адреса дошки. */
  href: string;
  external: boolean;
};

export type HomeBoard =
  | { available: true; stats: HomeStats; ticker: TickerJob[] }
  | { available: false; stats: null; ticker: [] };

const UNAVAILABLE: HomeBoard = { available: false, stats: null, ticker: [] };

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
    newThisWeek: all.filter((j) => j.postedMs !== null && j.postedMs >= since && j.postedMs <= t).length,
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

/** Посилання стрічки: вакансія компанії веде на її сторінку в нас, сканована лише на http(s). */
export function tickerHref(job: PoolJob): { href: string; external: boolean } | null {
  if (job.source === "company") return { href: `/jobs/${encodeURIComponent(job.jobId)}`, external: false };
  try {
    const u = new URL(job.url);
    return u.protocol === "https:" || u.protocol === "http:" ? { href: u.toString(), external: true } : null;
  } catch {
    return null;
  }
}

/**
 * До `size` вакансій із зарплатою для стрічки, одна на компанію, по черзі з різних ролей
 * (у кожній ролі найсвіжіші першими), щоб стрічка не була самими інженерами.
 * Не беремо: без зарплати чи без валюти («150k» без валюти нічого не каже), з кривим чи
 * не http(s) посиланням, з національних дощок (country: назви мовою країни).
 */
export function tickerJobs(all: readonly PoolJob[], size = TICKER_SIZE): TickerJob[] {
  type Cand = { job: PoolJob; salary: string; link: { href: string; external: boolean } };
  const cands: Cand[] = [];
  for (const job of all) {
    if (job.country || !job.salary?.currency || job.roles.length === 0) continue;
    const salary = formatSalary(job.salary);
    const link = tickerHref(job);
    if (!salary || !link) continue;
    cands.push({ job, salary, link });
  }
  // Новіші за датою публікації спершу; без дати після всіх датованих (відсутнє значення
  // не випереджає справжнє), серед них за тим, коли скан бачив; далі за jobId.
  const at = (j: PoolJob) => j.postedMs ?? j.seenMs ?? 0;
  cands.sort(
    (a, b) =>
      Number(a.job.postedMs === null) - Number(b.job.postedMs === null) ||
      at(b.job) - at(a.job) ||
      (a.job.jobId < b.job.jobId ? -1 : a.job.jobId > b.job.jobId ? 1 : 0),
  );

  // Черги за першою роллю вакансії, у порядку, в якому роль уперше трапилась (найсвіжіша першою).
  const queues = new Map<string, Cand[]>();
  for (const c of cands) {
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
      out.push({
        ref: c.job.source === "company" ? `co:${c.job.jobId}` : `nr:${c.job.jobId.replace(/^nr_/, "")}`,
        title: cleanText(c.job.title, 70),
        company: cleanText(c.job.company, 40),
        place: c.job.location ? cleanText(c.job.location, 36) : null,
        salary: c.salary,
        href: c.link.href,
        external: c.link.external,
      });
      if (out.length >= size) break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Табло з кешем

let board: { at: number; value: HomeBoard } | null = null;

/** Для тестів: наступний виклик рахує знову. */
export function resetHomeBoard(): void {
  board = null;
}

export async function homeBoard(deps: {
  db: () => D1Database;
  env: { SITE_URL?: string };
  jobs: () => JobsDb;
  now: Date;
}): Promise<HomeBoard> {
  const t = Date.now();
  if (board && t - board.at < (board.value.available ? POOL_TTL_MS : FAILURE_BACKOFF_MS)) return board.value;
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
      value = { available: true, stats: homeStats(crawl, company, deps.now), ticker: tickerJobs([...company, ...crawl]) };
    }
  } catch (e) {
    // Напр. немає прив'язки DB поза Worker: головна однаково відкривається.
    console.warn(`home: live board failed (${e instanceof Error ? e.name : "unknown"})`);
    value = UNAVAILABLE;
  }
  board = { at: Date.now(), value };
  return value;
}
