import { loadCompanyJobs } from "@/lib/crm/public-jobs";
import { cleanText } from "@/lib/digest/format";
import { ROLES, type RoleKey } from "@/lib/card/roles";
import type { JobsDb } from "@/lib/jobs-db";
import { crawlPool, FAILURE_BACKOFF_MS, POOL_TTL_MS, type PoolJob } from "./pool";

/**
 * Сторінки категорій /crypto-jobs/<роль>[/remote]: єдиний шлях, яким пошук бачить наші вакансії
 * (сторінки самих сканованих вакансій noindex). Сторінка показує назву, компанію, місце й дату,
 * опису вакансії не копіює.
 *
 * Читань бази нових немає: усе рахується з того самого пулу, що табло головної (pool.ts, пам'ять
 * ізолята POOL_TTL_MS, плюс живі вакансії компаній одним читанням). Готовий зріз усіх ролей лежить
 * у кеші краю на годину, як табло (home-board.ts): 30 сторінок та sitemap не множать читання.
 */

/** Скільки вакансій у списку сторінки. */
export const CATEGORY_LIST_SIZE = 20;
/** Менше цього сторінка не потрібна пошуку: noindex і поза sitemap. */
export const CATEGORY_MIN_JOBS = 3;
/** Скільки вакансій однієї компанії в списку: щоб один великий роботодавець не забив усе. */
const PER_COMPANY = 2;

export type CategoryRole = {
  role: RoleKey;
  /** Адреса в URL: /crypto-jobs/<slug>. */
  slug: string;
  /** Назва в H1 і в тексті: «Remote crypto {noun} jobs». */
  noun: string;
  /** Що це за робота: одне-два прості речення. */
  about: string;
};

/** Ролі сайту (card/roles.ts) з адресами й простим текстом. Порядок = порядок у хабі. */
export const CATEGORY_ROLES: readonly CategoryRole[] = [
  { role: "engineer", slug: "engineer", noun: "engineer", about: "Engineers write and ship the code behind protocols, wallets, apps and infrastructure. Smart contracts, backend, frontend and node work all sit here." },
  { role: "security_auditor", slug: "security-auditor", noun: "security auditor", about: "Security auditors review smart contracts and systems for bugs before attackers find them. Audit firms, protocols and exchanges hire for it." },
  { role: "devrel", slug: "devrel", noun: "developer relations", about: "DevRel people help outside developers build on a protocol. They write docs, give talks, run hackathons and answer questions in public." },
  { role: "data_research", slug: "data-research", noun: "data and research", about: "Data and research roles turn onchain data and market structure into answers. Analysts, researchers and data engineers work here." },
  { role: "product_manager", slug: "product-manager", noun: "product manager", about: "Product and project managers decide what gets built and keep teams on schedule. They work between engineers, designers and users." },
  { role: "bd", slug: "bd", noun: "business development", about: "Business development and partnerships roles bring in integrations, listings and deals. Most of the work is talking to other teams and closing." },
  { role: "marketing_content", slug: "marketing", noun: "marketing and content", about: "Marketing and content roles explain a product to the market. Writers, growth marketers and brand people work here." },
  { role: "creator_kol", slug: "creator-kol", noun: "creator and KOL", about: "Creators and KOLs build an audience on X, YouTube or Telegram. Projects hire them for reach and for trusted explanations." },
  { role: "community", slug: "community", noun: "community", about: "Community roles keep a project's members active and informed. Moderators and community managers run Discord, Telegram and X." },
  { role: "trader", slug: "trader", noun: "trader", about: "Traders and market makers work with liquidity, pricing and risk on exchanges and onchain venues. Track record matters more than a CV." },
  { role: "designer", slug: "designer", noun: "designer", about: "Designers shape how crypto products look and feel. Product, brand and motion design all appear in this list." },
  { role: "operations_support", slug: "operations", noun: "operations and support", about: "Operations and support roles keep the team and its users running. They cover customer support, admin and day-to-day process." },
  { role: "finance", slug: "finance", noun: "finance", about: "Finance roles cover accounting, treasury and reporting for crypto companies and DAOs." },
  { role: "legal_compliance", slug: "legal-compliance", noun: "legal and compliance", about: "Legal and compliance roles handle regulation, licences and risk for crypto companies. Counsel and compliance officers work here." },
  { role: "hr_recruiting", slug: "hr-recruiting", noun: "HR and recruiting", about: "HR and recruiting roles hire and look after people at crypto teams. Recruiters and people-ops staff work here." },
];

export function categoryBySlug(slug: string): CategoryRole | null {
  return CATEGORY_ROLES.find((c) => c.slug === slug) ?? null;
}

/** Вакансія в списку сторінки: лише назва, компанія, місце, дата й куди вести. */
export type CategoryJob = {
  /** Адреса на сайті: /jobs/<id>. */
  href: string;
  title: string;
  company: string;
  place: string | null;
  /** Коли опубліковано (мс), або коли вперше побачили; null, якщо дати немає. */
  atMs: number | null;
};

export type CategorySlice = { count: number; jobs: CategoryJob[] };
export type CategoryRoleData = { all: CategorySlice; remote: CategorySlice };

/** Зріз усіх ролей: цей об'єкт і лежить у кеші краю. */
export type CategoryIndex = {
  /** Коли зріз зібрано (мс): lastmod у sitemap. */
  builtMs: number;
  /** Вакансій усього (кожна раз, хоч би скільки в неї ролей). */
  total: number;
  /** Найсвіжіше, що бачив скан або опублікувала компанія (мс), або null. */
  updatedMs: number | null;
  roles: Record<RoleKey, CategoryRoleData>;
};

const hrefOf = (j: PoolJob) => `/jobs/${encodeURIComponent(j.jobId.replace(/^nr_/, ""))}`;
const atOf = (j: PoolJob) => j.postedMs ?? j.firstSeenMs ?? j.seenMs ?? null;

function slice(jobs: readonly PoolJob[]): CategorySlice {
  const sorted = [...jobs].sort(
    (a, b) =>
      Number(a.postedMs === null) - Number(b.postedMs === null) ||
      (atOf(b) ?? 0) - (atOf(a) ?? 0) ||
      (a.jobId < b.jobId ? -1 : a.jobId > b.jobId ? 1 : 0),
  );
  const perCompany = new Map<string, number>();
  const out: CategoryJob[] = [];
  for (const j of sorted) {
    if (out.length >= CATEGORY_LIST_SIZE) break;
    const n = perCompany.get(j.companyKey) ?? 0;
    if (n >= PER_COMPANY) continue;
    perCompany.set(j.companyKey, n + 1);
    out.push({
      href: hrefOf(j),
      title: cleanText(j.title, 90),
      company: cleanText(j.company, 50),
      place: j.location ? cleanText(j.location, 40) : null,
      atMs: atOf(j),
    });
  }
  return { count: jobs.length, jobs: out };
}

/**
 * Зріз за ролями. Вакансія може мати кілька ролей: вона йде в кожну свою. Національні дошки
 * (country) не беремо: назви мовою країни на англійській сторінці не читаються. «Remote» це
 * workMode із remote, як у пошуку.
 */
export function buildCategoryIndex(all: readonly PoolJob[], now: Date): CategoryIndex {
  const usable = all.filter((j) => !j.country && j.roles.length > 0);
  const t = now.getTime();
  let updatedMs: number | null = null;
  for (const j of usable) {
    const ms = j.source === "company" ? j.postedMs : j.seenMs;
    if (ms !== null && ms <= t && (updatedMs === null || ms > updatedMs)) updatedMs = ms;
  }
  const roles = {} as Record<RoleKey, CategoryRoleData>;
  for (const key of Object.keys(ROLES) as RoleKey[]) {
    const mine = usable.filter((j) => j.roles.includes(key));
    roles[key] = { all: slice(mine), remote: slice(mine.filter((j) => j.workMode.includes("remote"))) };
  }
  return { builtMs: t, total: usable.length, updatedMs, roles };
}

/** Сторінку пускаємо в пошук лише тоді, коли на ній є що показати. */
export function indexable(s: CategorySlice): boolean {
  return s.count >= CATEGORY_MIN_JOBS;
}

// ---------------------------------------------------------------------------
// Кеш: пам'ять ізолята + край (той самий шаблон, що в home-board.ts)

let cachedIndex: { at: number; value: CategoryIndex | null } | null = null;

/** Для тестів. */
export function resetCategoryIndex(): void {
  cachedIndex = null;
}

const EDGE_PATH = "/__cache/categories/v1";
/** Скільки зріз живе в краю: скан оновлює базу раз на добу, годину беремо як табло головної. */
export const CATEGORY_EDGE_TTL_S = 3600;

function edgeKey(env: { SITE_URL?: string }): string {
  const base = env.SITE_URL?.startsWith("http") ? env.SITE_URL : "https://nextcryptojob.xyz";
  return new URL(EDGE_PATH, base).toString();
}

function edgeCache(): Cache | null {
  try {
    const c = (globalThis as { caches?: { default?: Cache } }).caches;
    return c?.default ?? null;
  } catch {
    return null;
  }
}

async function fromEdge(env: { SITE_URL?: string }): Promise<CategoryIndex | null> {
  const c = edgeCache();
  if (!c) return null;
  try {
    const hit = await c.match(edgeKey(env));
    if (!hit) return null;
    const value = (await hit.json()) as CategoryIndex;
    return value?.roles ? value : null;
  } catch (e) {
    console.warn(`categories: edge cache read failed (${e instanceof Error ? e.message : "unknown"})`);
    return null;
  }
}

async function toEdge(env: { SITE_URL?: string }, value: CategoryIndex): Promise<void> {
  const c = edgeCache();
  if (!c) return;
  try {
    await c.put(
      edgeKey(env),
      new Response(JSON.stringify(value), {
        headers: { "content-type": "application/json", "cache-control": `max-age=${CATEGORY_EDGE_TTL_S}` },
      }),
    );
  } catch (e) {
    console.warn(`categories: edge cache write failed (${e instanceof Error ? e.message : "unknown"})`);
  }
}

/**
 * Зріз для сторінок категорій. null, коли бази вакансій немає: сторінка тоді каже, що вакансій
 * поки нема, і стоїть noindex (не віддаємо пошуку порожнє за правду).
 */
export async function categoryIndex(deps: {
  db: () => D1Database;
  env: { SITE_URL?: string };
  jobs: () => JobsDb;
  now: Date;
}): Promise<CategoryIndex | null> {
  const t = Date.now();
  if (cachedIndex && t - cachedIndex.at < (cachedIndex.value ? POOL_TTL_MS : FAILURE_BACKOFF_MS)) return cachedIndex.value;
  const shared = await fromEdge(deps.env);
  if (shared) {
    cachedIndex = { at: Date.now(), value: shared };
    return shared;
  }
  let value: CategoryIndex | null = null;
  try {
    const crawl = await crawlPool(deps.jobs, deps.now);
    if (crawl) {
      let company: PoolJob[] = [];
      try {
        company = await loadCompanyJobs(deps.db(), deps.env);
      } catch (e) {
        console.warn(`categories: company jobs read failed (${e instanceof Error ? e.name : "unknown"})`);
      }
      value = buildCategoryIndex([...company, ...crawl], deps.now);
    }
  } catch (e) {
    console.warn(`categories: index failed (${e instanceof Error ? e.name : "unknown"})`);
  }
  cachedIndex = { at: Date.now(), value };
  if (value) await toEdge(deps.env, value);
  return value;
}

// ---------------------------------------------------------------------------
// Тексти сторінки (окремо від React, щоб тест міряв довжини)

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** H1 і title: «Remote crypto engineer jobs» або «Crypto engineer jobs». */
export function categoryHeading(c: CategoryRole, remote: boolean): string {
  return remote ? `Remote crypto ${c.noun} jobs` : cap(`crypto ${c.noun} jobs`);
}

/** description: 120 до 155 знаків за будь-якого числа до 99 999. */
export function categoryDescription(c: CategoryRole, remote: boolean, count: number): string {
  const what = `${remote ? "remote " : ""}crypto ${c.noun} jobs`;
  return `Browse ${count.toLocaleString("en-US")} current ${what}, with company, place and date. Get the best matches by Telegram or email every day. Free.`;
}

/** Рядок брифу для /start?brief=…: людина потрапляє в анкету з уже вписаною роллю. */
export function categoryBrief(c: CategoryRole, remote: boolean): string {
  return `${cap(c.noun)}${remote ? ", remote" : ""}`;
}
