import { brandKey } from "./clean";
import type { JobsDb } from "@/lib/jobs-db";
import { FAILURE_BACKOFF_MS, POOL_TTL_MS } from "./pool";
import { type TokenColumns, type TokenQuote, tokenQuoteOf } from "./token";

/**
 * Що відомо про роботодавця (реєстр companies у базі вакансій, стовпці domain і about з db/jobs 0005,
 * токен з db/jobs 0004): домен для значка на картці вакансії, одне-два речення про те, що компанія
 * робить, і ринкові дані її токена. Пише їх engine (jobs-about, jobs-tokens) лише з джерел, які самі
 * це дають; сайт лише читає.
 *
 * Читання: один запит на кілька сотень рядків, і лише коли ізолят не має свіжої копії (POOL_TTL_MS, як
 * пул вакансій). Без 0005 чи коли база не відповіла: порожньо, картки показують літеру замість значка й
 * без речення. Без 0004 (стовпці токена ще не накотили): domain і about лишаються, токена просто немає
 * (selectCompanyRows пробує без цих стовпців). Той самий набір доменів тримає й /api/logo: значок
 * береться лише для домену з реєстру.
 */

export type CompanyProfile = { domain: string | null; about: string | null; token: TokenQuote | null };

/** Той самий запит, що в engine (engine/src/digest/jobs.ts PROFILES_SQL). */
export const PROFILES_SQL = `SELECT name, domain, about, token_symbol, token_price_usd, token_mcap_usd, token_change_24h, token_updated_at
  FROM companies WHERE domain IS NOT NULL OR about IS NOT NULL OR token_price_usd IS NOT NULL`;
/** Той самий запит без стовпців 0004 (токена ще не накотили): профілі йдуть без токена. */
export const PROFILES_SQL_NO_TOKEN = "SELECT name, domain, about FROM companies WHERE domain IS NOT NULL OR about IS NOT NULL";

/** Домен як ім'я хоста: лише літери, цифри, дефіс і крапки, щонайменше дві частини. */
export const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function cleanDomain(raw: string | null | undefined): string | null {
  const d = raw?.trim().toLowerCase().replace(/^www\./, "") ?? "";
  return d.length <= 253 && DOMAIN_RE.test(d) ? d : null;
}

export type CompanyProfiles = {
  /** Ключ компанії (companyKey назви, як jobs_cache.company_key) → профіль. */
  byKey: Map<string, CompanyProfile>;
  /** Усі домени реєстру: лише для них /api/logo бере значок. */
  domains: Set<string>;
};

export const EMPTY_PROFILES: CompanyProfiles = { byKey: new Map(), domains: new Set() };

type Row = { name: string; domain: string | null; about: string | null } & TokenColumns;

/**
 * Рядки реєстру → профілі за ключем. Ключ тут brandKey, не голий companyKey: «Jito Labs» двома
 * рядками (два ATS, 15.09: дубль у companies) і будь-яка пара «X» / «X Labs» чи «X Foundation»
 * зливаються в один профіль. Два рядки з одним ключем: перший непорожній домен, опис і токен.
 */
export function profilesOf(rows: readonly Row[]): CompanyProfiles {
  const byKey = new Map<string, CompanyProfile>();
  const domains = new Set<string>();
  for (const r of rows) {
    const key = brandKey(r.name);
    if (!key) continue;
    const domain = cleanDomain(r.domain);
    const about = r.about?.replace(/\s+/g, " ").trim() || null;
    const token = tokenQuoteOf(r);
    if (domain) domains.add(domain);
    const cur = byKey.get(key);
    byKey.set(key, { domain: cur?.domain ?? domain, about: cur?.about ?? about, token: cur?.token ?? token });
  }
  return { byKey, domains };
}

/**
 * Рядки реєстру, з фолбеком без стовпців токена (db/jobs 0004): читання лишається одне на успіх, і
 * лише коли 0004 ще не накотили пробує вдруге без цих стовпців (ONCE тут, а не в кожному читачі).
 * "no such table" (0005 теж немає): порожньо, без другої спроби.
 */
export async function selectCompanyRows(jobs: JobsDb): Promise<Row[]> {
  try {
    return await jobs.all<Row>(PROFILES_SQL);
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    if (!/no such column/i.test(msg)) throw e;
    return await jobs.all<Row>(PROFILES_SQL_NO_TOKEN);
  }
}

let cached: { at: number; value: CompanyProfiles } | null = null;
let failedAt: number | null = null;

/** Для тестів: наступний виклик читає знову. */
export function resetCompanyProfiles(): void {
  cached = null;
  failedAt = null;
}

/** Профілі компаній з пам'яті ізолята або одним читанням; ніколи не кидає. */
export async function companyProfiles(open: () => JobsDb): Promise<CompanyProfiles> {
  const t = Date.now();
  if (cached && t - cached.at < POOL_TTL_MS) return cached.value;
  if (failedAt !== null && t - failedAt < FAILURE_BACKOFF_MS) return cached?.value ?? EMPTY_PROFILES;
  try {
    const rows = await selectCompanyRows(open());
    cached = { at: Date.now(), value: profilesOf(rows) };
    failedAt = null;
    return cached.value;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    // Без 0005 стовпців немає: це не збій, просто ще нема чого показати.
    if (/no such column|no such table/i.test(msg)) {
      cached = { at: Date.now(), value: EMPTY_PROFILES };
      return EMPTY_PROFILES;
    }
    console.warn(`jobs: company profiles read failed (${e instanceof Error ? e.name : "unknown"})`);
    failedAt = Date.now();
    return cached?.value ?? EMPTY_PROFILES;
  }
}

/** Профіль компанії вакансії за її ключем (brandKey); null, якщо про неї нічого не знаємо. */
export function profileFor(p: CompanyProfiles, key: string | null | undefined, name?: string): CompanyProfile | null {
  return p.byKey.get(key || brandKey(name ?? "")) ?? null;
}

/** Адреса значка компанії на нашому сайті (/api/logo), або null без домену. */
export function logoPath(domain: string | null | undefined): string | null {
  const d = cleanDomain(domain);
  return d ? `/api/logo/${d}` : null;
}
