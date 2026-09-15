// Ключі рядка jobs_cache: id з адреси і ключ змісту (компанія + назва).
// titleKey перенесено з NextRole (crypto-jobs-agent, scanner): src/normalize.ts.
import { createHash } from "node:crypto";
import { brandKey } from "../digest/clean.js";

/**
 * id вакансії з її адреси: 'j' + 24 hex від sha256. Та сама адреса завжди дає той самий id, тож:
 * - окремий UNIQUE на url не потрібен (менше записів D1, db/jobs/0001_schema.sql);
 * - вакансія, яку прибрав jobs-prune, а скан потім побачив знову, повертається з тим самим id,
 *   і `sent.job_ref` (nr:<id>) не дасть надіслати її людині вдруге.
 * 96 біт: на сотні тисяч адрес ймовірність збігу нехтовна.
 *
 * Джерело, чия адреса несе його мітки (web3.career: apply_url, який не можна правити), дає замість
 * адреси стійкий ключ (RawJob.idKey, «web3career:<номер>»): id той самий, хоч би мітки змінились.
 */
export function jobId(urlOrKey: string): string {
  return `j${createHash("sha256").update(urlOrKey.trim()).digest("hex").slice(0, 24)}`;
}

/** Шум, який відрізняє публікації тієї самої ролі в різних країнах. */
const TITLE_NOISE = /\((?:m\/f\/d|m\/w\/d|m\/f\/x|w\/m\/d|h\/f|f\/h|m\/f|remote|hybrid|onsite|contract|fixed[- ]term)\)/gi;

const collapse = (v: string): string => v.replace(/\s+/g, " ").trim();

export function titleKey(title: string): string {
  const latin = collapse(title.toLowerCase().replace(TITLE_NOISE, " ").replace(/[^a-z0-9\s]/g, " "));
  // Назва без латиниці («Розробник Solidity» лишив би «solidity», а суто кирилична порожнє):
  // порожній ключ склеїв би всі такі вакансії компанії в одну.
  return latin || collapse(title.toLowerCase());
}

/**
 * Ключ змісту: компанія + роль без локації, тож геоклони й та сама вакансія на дошці та в ATS
 * схлопуються. Компанія тут brandKey, а не голий companyKey: «Morpho» і «Morpho Labs» з тим самим
 * заголовком мають дати один ключ (engine/src/digest/clean.ts), інакше однакова вакансія під
 * двома назвами компанії проходить дедуп окремо (15.09, «Account Growth, Morpho, Paris» і
 * «Account Growth, Morpho Labs, Paris»).
 */
export const dedupeKey = (company: string, title: string): string => `${brandKey(company)}|${titleKey(title)}`;
