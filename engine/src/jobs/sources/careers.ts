// Сторінка кар'єри роботодавця → його ATS (розвідка, discover.ts). Вакансія на дошці екосистеми
// часто веде не прямо в ATS, а на сайт компанії (`acme.xyz/careers?gh_jid=…`), де дошку ATS вбудовано
// скриптом чи посиланням. Читаємо ОДНУ сторінку самого роботодавця (не дошки Getro), а за потреби ще
// його `/careers`, і шукаємо в розмітці адреси ATS, які скан уміє читати.
import { fetchXml, type FetchOptions } from "../../http.js";
import type { AtsProvider } from "../types.js";
import { extractAts } from "./getro.js";

export interface AtsHit { provider: AtsProvider; slug: string }

/** Адреси в розмітці: href/src і будь-який рядок, схожий на адресу ATS (скрипти вбудовування). */
const URLISH = /(?:https?:)?\/\/[a-z0-9.-]+\.(?:greenhouse\.io|lever\.co|ashbyhq\.com|workable\.com|smartrecruiters\.com|breezy\.hr|rippling\.com|personio\.(?:de|com)|bamboohr\.com|recruitee\.com|teamtailor\.com|gem\.com|pinpointhq\.com|hibob\.com|myworkdayjobs\.com)[^\s"'<>)\\]*/gi;

/**
 * ATS з розмітки сторінки: найчастіша пара «провайдер + слаг» (сторінка з десятком посилань на
 * jobs.ashbyhq.com/acme і одним на чужу дошку в підвалі віддає acme). null, якщо адрес ATS немає.
 */
export function atsFromHtml(html: string): AtsHit | null {
  const counts = new Map<string, { hit: AtsHit; n: number; first: number }>();
  let i = 0;
  for (const m of html.replace(/&amp;/g, "&").matchAll(URLISH)) {
    const raw = m[0].startsWith("//") ? `https:${m[0]}` : m[0];
    const hit = extractAts(raw);
    if (!hit) continue;
    const key = `${hit.provider}:${hit.slug.toLowerCase()}`;
    const c = counts.get(key);
    if (c) c.n++; else counts.set(key, { hit, n: 1, first: i++ });
  }
  const best = [...counts.values()].sort((a, b) => b.n - a.n || a.first - b.first)[0];
  return best?.hit ?? null;
}

/** Параметри адреси, якими сайт роботодавця каже, чий у нього ATS (без слага). */
export function atsHintFromUrl(url: string): AtsProvider | null {
  if (/[?&]gh_jid=/i.test(url)) return "greenhouse";
  if (/[?&]ashby_jid=/i.test(url)) return "ashby";
  if (/[?&]lever-(?:origin|source)/i.test(url)) return "lever";
  return null;
}

/**
 * ATS роботодавця за адресою його сторінки: спершу сама сторінка, потім `/careers` того ж сайту
 * (дві сторінки найбільше). Помилка мережі = null: розвідка просто не візьме компанію цього тижня.
 */
export async function resolveCareerPage(url: string, o: FetchOptions = {}): Promise<{ hit: AtsHit; from: string } | null> {
  let origin: string;
  try { origin = new URL(url).origin; } catch { return null; }
  const tried = new Set<string>();
  for (const candidate of [url, `${origin}/careers`]) {
    if (tried.has(candidate)) continue;
    tried.add(candidate);
    try {
      // fetchXml шле Accept з */*: HTML-сторінку віддасть будь-який сайт (так читає сторінки й boards.ts).
      const html = await fetchXml(candidate, {}, { retries: 0, timeoutMs: 15_000, ...o });
      const hit = atsFromHtml(html);
      if (hit) return { hit, from: candidate };
    } catch { /* сторінки немає або сайт не відповів: наступна */ }
  }
  return null;
}

/** Посилання «кар'єра» з головної сторінки сайту: на тому ж домені чи піддомені (careers.acme.xyz). */
export function careerLinks(html: string, base: string): string[] {
  let root: string;
  try { root = new URL(base).hostname.toLowerCase().replace(/^www\./, ""); } catch { return []; }
  const out: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    const href = m[1]!.trim();
    const text = m[2]!.replace(/<[^>]+>/g, " ");
    if (!/career|jobs|join[- ]?us|hiring|work[- ]with[- ]us/i.test(`${href} ${text}`)) continue;
    let u: URL;
    try { u = new URL(href, base); } catch { continue; }
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (u.protocol !== "https:" && u.protocol !== "http:") continue;
    if (host !== root && !host.endsWith(`.${root}`)) continue;
    const s = u.toString();
    if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, 3);
}

/**
 * ATS компанії за адресою її сайту (руками з публічної сторінки портфеля фонду): головна, посилання
 * «кар'єра» з неї, далі `/careers` і `/jobs`. Не більше чотирьох сторінок сайту роботодавця.
 */
export async function resolveCompanySite(site: string, o: FetchOptions = {}): Promise<{ hit: AtsHit; from: string } | null> {
  let origin: string;
  try { origin = new URL(site).origin; } catch { return null; }
  const read = async (u: string): Promise<string | null> => {
    try { return await fetchXml(u, {}, { retries: 0, timeoutMs: 15_000, ...o }); } catch { return null; }
  };
  const home = await read(site);
  if (home) {
    const hit = atsFromHtml(home);
    if (hit) return { hit, from: site };
  }
  const queue = [...(home ? careerLinks(home, site) : []), `${origin}/careers`, `${origin}/jobs`];
  const tried = new Set<string>([site]);
  for (const u of queue) {
    if (tried.has(u) || tried.size > 4) continue;
    tried.add(u);
    const html = await read(u);
    const hit = html ? atsFromHtml(html) : null;
    if (hit) return { hit, from: u };
  }
  return null;
}
