import { companyKey } from "./clean";
import type { JobsDb } from "@/lib/jobs-db";
import { FAILURE_BACKOFF_MS, POOL_TTL_MS } from "./pool";

/**
 * Що відомо про роботодавця (реєстр companies у базі вакансій, стовпці domain і about з db/jobs 0005):
 * домен для значка на картці вакансії й одне-два речення про те, що компанія робить. Пише їх engine
 * (jobs-about) лише з джерел, які самі це дають; сайт лише читає.
 *
 * Читання: один запит на кілька сотень рядків, і лише коли ізолят не має свіжої копії (POOL_TTL_MS, як
 * пул вакансій). Без 0005 чи коли база не відповіла: порожньо, картки показують літеру замість значка й
 * без речення. Той самий набір доменів тримає й /api/logo: значок береться лише для домену з реєстру.
 */

export type CompanyProfile = { domain: string | null; about: string | null };

/** Той самий запит, що в engine (engine/src/digest/jobs.ts PROFILES_SQL). */
export const PROFILES_SQL = "SELECT name, domain, about FROM companies WHERE domain IS NOT NULL OR about IS NOT NULL";

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

const EMPTY: CompanyProfiles = { byKey: new Map(), domains: new Set() };

type Row = { name: string; domain: string | null; about: string | null };

/** Рядки реєстру → профілі за ключем. Два рядки з одним ключем: перший непорожній домен і опис. */
export function profilesOf(rows: readonly Row[]): CompanyProfiles {
  const byKey = new Map<string, CompanyProfile>();
  const domains = new Set<string>();
  for (const r of rows) {
    const key = companyKey(r.name);
    if (!key) continue;
    const domain = cleanDomain(r.domain);
    const about = r.about?.replace(/\s+/g, " ").trim() || null;
    if (domain) domains.add(domain);
    const cur = byKey.get(key);
    byKey.set(key, { domain: cur?.domain ?? domain, about: cur?.about ?? about });
  }
  return { byKey, domains };
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
  if (failedAt !== null && t - failedAt < FAILURE_BACKOFF_MS) return cached?.value ?? EMPTY;
  try {
    const rows = await open().all<Row>(PROFILES_SQL);
    cached = { at: Date.now(), value: profilesOf(rows) };
    failedAt = null;
    return cached.value;
  } catch (e) {
    const msg = e instanceof Error ? e.message : "unknown";
    // Без 0005 стовпців немає: це не збій, просто ще нема чого показати.
    if (/no such column|no such table/i.test(msg)) {
      cached = { at: Date.now(), value: EMPTY };
      return EMPTY;
    }
    console.warn(`jobs: company profiles read failed (${e instanceof Error ? e.name : "unknown"})`);
    failedAt = Date.now();
    return cached?.value ?? EMPTY;
  }
}

/** Профіль компанії вакансії за її ключем; null, якщо про неї нічого не знаємо. */
export function profileFor(p: CompanyProfiles, key: string | null | undefined, name?: string): CompanyProfile | null {
  return p.byKey.get(key || companyKey(name ?? "")) ?? null;
}

/** Адреса значка компанії на нашому сайті (/api/logo), або null без домену. */
export function logoPath(domain: string | null | undefined): string | null {
  const d = cleanDomain(domain);
  return d ? `/api/logo/${d}` : null;
}
