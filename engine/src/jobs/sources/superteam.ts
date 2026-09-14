// Superteam Earn: баунті й проєкти екосистеми Solana. Необов'язкове джерело, типово вимкнене
// (JOBS_SUPERTEAM=1 вмикає).
/**
 * Чому окремо й чому вимкнено. Це не вакансії, а разові завдання з винагородою в токенах (дописи,
 * відео, дизайн, ідеї): 14.09 з 22 відкритих 21 баунті й 1 проєкт. Для ролей Creator / KOL і
 * Community це майже єдине джерело, але зарплати тут немає, а строк короткий, тож показувати їх
 * поруч із вакансіями вирішує власник.
 *
 * Умови: robots.txt «Allow: /» і прямо запрошує агентів до API (skill.md); сторінка умов
 * переадресовує, прочитати її скриптом не вдалось (13.09), тож «не заборонено» тут не перевірено.
 * Публічний JSON без ключа: https://superteam.fun/api/listings.
 */
import { fetchJson, type FetchOptions } from "../../http.js";
import type { RawJob } from "../types.js";

export const SUPERTEAM_SOURCE = "aggregator:superteam";
const API = "https://superteam.fun/api/listings";

interface Listing {
  slug?: string; title?: string; type?: string; status?: string; deadline?: string | null;
  rewardAmount?: number | null; token?: string | null; compensationType?: string | null;
  sponsor?: { name?: string } | null;
}

export function parseSuperteam(rows: readonly Listing[], now: Date): RawJob[] {
  const out: RawJob[] = [];
  for (const l of rows) {
    if (!l.slug || !l.title || !l.sponsor?.name) continue;
    if ((l.status ?? "").toUpperCase() !== "OPEN") continue;
    const deadline = l.deadline ? Date.parse(l.deadline) : NaN;
    if (Number.isFinite(deadline) && deadline < now.getTime()) continue;
    const kind = l.type === "project" ? "Project" : "Bounty";
    out.push({
      url: `https://superteam.fun/earn/listing/${encodeURIComponent(l.slug)}`,
      company: l.sponsor.name, title: `${kind}: ${l.title}`.slice(0, 200),
      location: null, remote: true, postedAt: null, source: SUPERTEAM_SOURCE, crypto: true,
      // Винагорода разова, у токенах: це не річна зарплата, у вилку не йде.
    });
  }
  return out;
}

export async function fetchSuperteam(now: Date, o: FetchOptions = {}): Promise<RawJob[]> {
  const rows = await fetchJson<unknown>(API, {}, o);
  return parseSuperteam(Array.isArray(rows) ? (rows as Listing[]) : [], now);
}
