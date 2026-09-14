// Перенесено з NextRole (crypto-jobs-agent, scanner): src/normalize.ts (prepare, officeOnly, richness),
// з поправками під крипто-базу: лише крипто, список не-крипто компаній, вікно 30 днів, id з адреси.
import { companyKey, isNonCryptoCompany } from "../digest/clean.js";
import { dedupeKey, jobId } from "./ids.js";
import { extractSalary } from "./salary-text.js";
import { jobTags } from "./tags.js";
import type { JobRow, RawJob } from "./types.js";

/**
 * Скільки днів від публікації вакансія ще йде в базу. Крипто-вакансії стоять відкритими місяцями:
 * на 23 публічних крипто-дошках 13.09 з 1 572 відкритих позицій 14 днів і новіші мали 14%, 30 днів
 * і новіші 27%. 30 днів це й вікно пулу (engine/src/digest/jobs.ts POSTED_WINDOW_DAYS): старіше
 * в базі нікому не показується, а запис коштує. Змінна JOBS_WINDOW_DAYS.
 */
export const WINDOW_DAYS = 30;

const collapse = (v: string): string => v.replace(/\s+/g, " ").trim();

export function isFresh(postedAt: string | null, days: number, now: Date): boolean {
  if (!postedAt) return true; // частина джерел дати не публікує (Rippling, BambooHR)
  const t = new Date(postedAt).getTime();
  if (Number.isNaN(t)) return true;
  return (now.getTime() - t) / 86_400_000 <= days;
}

export const hasLiveUrl = (url: string): boolean => /^https?:\/\/\S+$/i.test(url.trim());

/**
 * Локація, яка прямо заперечує прапорець «віддалено»: «Tallinn Office», «NYC Office»,
 * «In office not remote». Слово «remote» поруч скасовує правило: «Remote or In Office»
 * пропонує обидва варіанти, і сховати справді віддалену вакансію гірше, ніж показати зайву офісну.
 */
export function officeOnly(location: string | null | undefined): boolean {
  const s = (location ?? "").trim();
  if (!s) return false;
  // Заперечення ПЕРШИМ: «In office not remote» містить слово «remote».
  if (/\b(?:not|non-?|no)\s*remote\b/i.test(s)) return true;
  if (/remote|anywhere|worldwide|télétravail|віддален|удалён/i.test(s)) return false;
  return /\boffice\b|on-?\s?site/i.test(s);
}

/**
 * Наскільки повний запис. Коли два джерела описують ту саму пару «компанія + роль», лишається
 * те, що знає більше: зарплата важить найбільше, бо саме за нею підбір відсіює найчастіше.
 */
function richness(j: RawJob): number {
  return (j.salaryMin != null || j.salaryMax != null ? 4 : 0)
       + (j.description?.trim() ? 2 : 0)
       + (j.postedAt ? 1 : 0)
       + (j.location?.trim() ? 1 : 0);
}

export interface Dropped {
  /** Джерело не каже, що це крипто (JobStash без крипто-позначки). */
  notCrypto: number;
  /** Компанія зі списку не-крипто (engine/src/digest/clean.ts). */
  company: number;
  /** Старіша за вікно. */
  old: number;
  /** Без робочої адреси, назви чи компанії. */
  broken: number;
  /** Та сама вакансія ще раз (той самий ключ змісту або та сама адреса). */
  duplicate: number;
}

export interface Prepared {
  rows: JobRow[];
  dropped: Dropped;
  /** Які не-крипто компанії відсіяно й скільки разів: щоб видно було, чи список не зачепив зайвого. */
  nonCrypto: Record<string, number>;
}

/**
 * Усі правила за один прохід: крипто → живий URL → компанія → вікно → вилка → дедуп.
 * Сортування стійке: рівні за повнотою лишаються в порядку надходження.
 */
export function prepare(jobs: readonly RawJob[], windowDays: number, now: Date): Prepared {
  const dropped: Dropped = { notCrypto: 0, company: 0, old: 0, broken: 0, duplicate: 0 };
  const nonCrypto: Record<string, number> = {};
  const seenKey = new Set<string>();
  const seenId = new Set<string>();
  const rows: JobRow[] = [];
  const fetchedAt = now.toISOString();
  const ordered = [...jobs].sort((a, b) => richness(b) - richness(a));
  for (const j of ordered) {
    if (!j.crypto) { dropped.notCrypto++; continue; }
    const url = j.url.trim();
    const title = collapse(j.title ?? "");
    const company = collapse(j.company ?? "");
    if (!hasLiveUrl(url) || !title || !company) { dropped.broken++; continue; }
    const key = companyKey(company);
    if (isNonCryptoCompany(key, company)) { dropped.company++; nonCrypto[company] = (nonCrypto[company] ?? 0) + 1; continue; }
    if (!isFresh(j.postedAt, windowDays, now)) { dropped.old++; continue; }
    // Адреса йде в базу як є (web3.career: apply_url без жодної правки); id зі стійкого ключа, якщо він є.
    const id = jobId(j.idKey?.trim() || url);
    const dk = dedupeKey(company, title);
    if (seenKey.has(dk) || seenId.has(id)) { dropped.duplicate++; continue; }
    seenKey.add(dk);
    seenId.add(id);

    const remote = officeOnly(j.location) ? false : j.remote;
    // Вилка з тексту лише тоді, коли джерело не дало її полем; сам текст у базу не йде.
    const hasPay = j.salaryMin != null || j.salaryMax != null;
    const parsed = hasPay ? null : extractSalary(j.description);
    const int = (v: number | null | undefined): number | null => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : null);
    rows.push({
      id, url, company, companyKey: key, title,
      location: j.location?.trim() ? collapse(j.location) : null,
      remote,
      salaryMin: hasPay ? int(j.salaryMin) : parsed?.min ?? null,
      salaryMax: hasPay ? int(j.salaryMax) : parsed?.max ?? null,
      salaryCurrency: hasPay ? (j.salaryCurrency?.trim().toUpperCase() || null) : parsed?.currency ?? null,
      source: j.source,
      tags: jobTags(title, remote, j.boardTags),
      dedupeKey: dk,
      postedAt: j.postedAt,
      fetchedAt,
    });
  }
  return { rows, dropped, nonCrypto };
}
