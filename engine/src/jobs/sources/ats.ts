// Перенесено з попереднього проєкту (сканер): src/sources/ats.ts. Teamtailor додано тут.
//
// Публічні API дошок вакансій (Greenhouse Job Board API, Lever Postings API, Ashby Posting API тощо):
// вони існують саме для того, щоб вакансії читали й показували. Кожна вакансія роботодавця з
// крипто-реєстру крипто за визначенням (crypto: true).
import { fetchJson, fetchXml, type FetchOptions } from "../../http.js";
import { ashbyPay, currencyCode, greenhousePay, leverPay, payFor, payPeriod,
  type AshbyComponent, type GreenhouseRange } from "../pay.js";
import type { AtsProvider, RawJob } from "../types.js";

const REMOTE = /remote|anywhere|distributed|home[- ]office|télétravail/i;
const iso = (v: unknown): string | null => {
  if (!v) return null;
  const d = new Date(typeof v === "number" ? v : String(v));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

/**
 * Slug стає частиною адреси, а в частини провайдерів і частиною ХОСТА. Джерела слагів: засів,
 * розвідка з чужих посилань, руки. Тут остання лінія: «evil.com/x?» замість слага вів би запит
 * на evil.com.
 */
const SLUG = /^[a-z0-9][a-z0-9_-]{0,62}$/i;
export function hostSlug(slug: string, provider: string): string {
  if (!SLUG.test(slug)) throw new Error(`${provider}: неприпустимий slug «${slug.slice(0, 40)}»`);
  return slug.toLowerCase();
}

/** Шлях: слаг Ashby буває з крапкою (kraken.com) і з %20 (Sui%20Foundation). */
const PATH_SLUG = /^[a-z0-9][a-z0-9_.%-]{0,80}$/i;
export function pathSlug(slug: string, provider: string): string {
  if (!PATH_SLUG.test(slug) || slug.includes("..") || /%(?!20)/i.test(slug)) {
    throw new Error(`${provider}: неприпустимий slug «${slug.slice(0, 40)}»`);
  }
  return slug;
}

const withCrypto = (jobs: Omit<RawJob, "crypto">[]): RawJob[] => jobs.map((j) => ({ ...j, crypto: true }));

// ── Greenhouse ────────────────────────────────────────────────
/**
 * `pay_transparency=true` додає `pay_input_ranges`: у Coinbase вилка стоїть на 213 вакансіях із
 * 218, у Ripple на 77 зі 124 (13.09.2026). Текст (`content=true`) не беремо: він важить мегабайти.
 */
export async function fetchGreenhouse(slug: string, name: string, o: FetchOptions = {}): Promise<RawJob[]> {
  const s = pathSlug(slug, "greenhouse");
  const p = await fetchJson<{ jobs?: Array<{ absolute_url: string; title: string; location?: { name?: string }; updated_at?: string; first_published?: string; pay_input_ranges?: GreenhouseRange[] }> }>(
    `https://boards-api.greenhouse.io/v1/boards/${s}/jobs?content=false&pay_transparency=true`, {}, o);
  return withCrypto((p.jobs ?? []).map((j) => {
    const loc = j.location?.name ?? null;
    return { url: j.absolute_url, company: name, title: j.title, location: loc,
      remote: REMOTE.test(loc ?? ""), postedAt: iso(j.first_published ?? j.updated_at), source: `greenhouse:${s}`,
      ...greenhousePay(j.pay_input_ranges) };
  }));
}

// ── Lever ─── назва вакансії в полі `text`, не `title`
export async function fetchLever(slug: string, name: string, o: FetchOptions = {}): Promise<RawJob[]> {
  return leverFrom("api.lever.co", "lever", slug, name, o);
}

/** Європейський Lever: той самий API на іншому хості (Aave Labs, Kaiko). */
export async function fetchLeverEu(slug: string, name: string, o: FetchOptions = {}): Promise<RawJob[]> {
  return leverFrom("api.eu.lever.co", "lever_eu", slug, name, o);
}

async function leverFrom(host: string, provider: string, slug: string, name: string, o: FetchOptions): Promise<RawJob[]> {
  const s = pathSlug(slug, provider);
  const posts = await fetchJson<Array<{
    text: string; hostedUrl?: string; applyUrl?: string; workplaceType?: string; createdAt?: number;
    categories?: { location?: string; team?: string; department?: string; commitment?: string };
    salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
    descriptionPlain?: string; descriptionBodyPlain?: string;
    lists?: Array<{ text?: string; content?: string }>;
  }>>(`https://${host}/v0/postings/${s}?mode=json`, {}, o);
  return withCrypto(posts.map((j) => {
    const loc = j.categories?.location ?? null;
    return {
      url: j.hostedUrl ?? j.applyUrl ?? "", company: name, title: j.text, location: loc,
      remote: j.workplaceType?.toLowerCase() === "remote" || REMOTE.test(loc ?? ""),
      postedAt: iso(j.createdAt), source: `${provider}:${s}`,
      ...leverPay(j.salaryRange),
      description: [j.descriptionBodyPlain ?? j.descriptionPlain ?? "",
        ...(j.lists ?? []).slice(0, 2).map((x) => `${x.text ?? ""}\n${x.content ?? ""}`)].join("\n\n").trim() || null,
    };
  }));
}

// ── Ashby ─── посилання в полі `jobUrl`
/** `includeCompensation=true` додає `compensation`: Kraken 30 з 74, Circle 10 з 10 (13.09.2026). */
export async function fetchAshby(slug: string, name: string, o: FetchOptions = {}): Promise<RawJob[]> {
  const s = pathSlug(slug, "ashby");
  const p = await fetchJson<{ jobs?: Array<{ title: string; location?: string; isRemote?: boolean; publishedAt?: string; jobUrl: string; isListed?: boolean; descriptionPlain?: string; compensation?: { summaryComponents?: AshbyComponent[] } }> }>(
    `https://api.ashbyhq.com/posting-api/job-board/${s}?includeCompensation=true`, {}, o);
  return withCrypto((p.jobs ?? []).filter((j) => j.isListed !== false).map((j) => ({
    url: j.jobUrl, company: name, title: j.title, location: j.location ?? null,
    remote: j.isRemote === true || REMOTE.test(j.location ?? ""),
    postedAt: iso(j.publishedAt), source: `ashby:${s}`,
    description: j.descriptionPlain ?? null,
    ...ashbyPay(j.compensation) })));
}

// ── Workable ──────────────────────────────────────────────────
export async function fetchWorkable(slug: string, name: string, o: FetchOptions = {}): Promise<RawJob[]> {
  const s = hostSlug(slug, "workable");
  const p = await fetchJson<{ jobs?: Array<{ title: string; location?: { city?: string; country?: string }; url?: string; shortcode?: string; published_on?: string; telecommuting?: boolean; description?: string }> }>(
    `https://apply.workable.com/api/v1/widget/accounts/${s}?details=true`, {}, o);
  return withCrypto((p.jobs ?? []).map((j) => {
    const loc = [j.location?.city, j.location?.country].filter(Boolean).join(", ") || null;
    return { url: j.url ?? `https://apply.workable.com/${s}/j/${j.shortcode}/`, company: name,
      title: j.title, location: loc, remote: j.telecommuting === true || REMOTE.test(loc ?? ""),
      postedAt: iso(j.published_on), source: `workable:${s}`, description: j.description ?? null };
  }));
}

// ── SmartRecruiters ───────────────────────────────────────────
export async function fetchSmartRecruiters(slug: string, name: string, o: FetchOptions = {}): Promise<RawJob[]> {
  const s = hostSlug(slug, "smartrecruiters");
  const p = await fetchJson<{ content?: Array<{ id: string; name: string; releasedDate?: string; location?: { city?: string; country?: string; remote?: boolean } }> }>(
    `https://api.smartrecruiters.com/v1/companies/${s}/postings?limit=100`, {}, o);
  return withCrypto((p.content ?? []).map((j) => {
    const loc = [j.location?.city, j.location?.country].filter(Boolean).join(", ") || null;
    return { url: `https://jobs.smartrecruiters.com/${s}/${j.id}`, company: name, title: j.name,
      location: loc, remote: j.location?.remote === true || REMOTE.test(loc ?? ""),
      postedAt: iso(j.releasedDate), source: `smartrecruiters:${s}` };
  }));
}

// ── Recruitee ─── європейський ATS, віддає ще й текст оголошення
/**
 * `country_code` у відповіді є, але в `country` рядка він НЕ йде: це поле означає «показувати
 * лише своїм» (національні дошки), а вакансія роботодавця адресована всім.
 */
export async function fetchRecruitee(rawSlug: string, name: string, o: FetchOptions = {}): Promise<RawJob[]> {
  const slug = hostSlug(rawSlug, "recruitee");
  const body = await fetchJson<{ offers?: Array<{
    title?: string; careers_url?: string; slug?: string; location?: string; city?: string;
    remote?: boolean; published_at?: string; created_at?: string;
    description?: string | null; requirements?: string | null; status?: string;
    salary?: { min?: string | number | null; max?: string | number | null; period?: string | null; currency?: string | null } | null;
  }> }>(`https://${slug}.recruitee.com/api/offers/`, {}, o);

  const out: RawJob[] = [];
  for (const j of body.offers ?? []) {
    const title = j.title?.trim();
    const url = j.careers_url ?? (j.slug ? `https://${slug}.recruitee.com/o/${j.slug}` : null);
    if (!title || !url) continue;
    // Чернетки й закриті позиції теж лежать у відповіді.
    if (j.status && j.status !== "published") continue;
    const loc = j.location?.trim() || j.city?.trim() || null;
    out.push({
      url, company: name, title, location: loc,
      remote: j.remote === true || REMOTE.test(`${loc ?? ""} ${title}`),
      postedAt: iso(j.published_at ?? j.created_at), source: `recruitee:${slug}`, crypto: true,
      description: [j.description, j.requirements].filter(Boolean).join("\n").replace(/<[^>]+>/g, " ") || null,
      ...recruiteePay(j.salary),
    });
  }
  return out;
}

/** Вилка Recruitee: числа бувають і рядками, період словом. */
function recruiteePay(s: { min?: string | number | null; max?: string | number | null; period?: string | null; currency?: string | null } | null | undefined) {
  const num = (v: unknown): number | null => {
    const n = typeof v === "number" ? v : typeof v === "string" ? Number(v.replace(/[^\d.]/g, "")) : NaN;
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return payFor(num(s?.min), num(s?.max), currencyCode(s?.currency), payPeriod(s?.period ?? null));
}

// ── Teamtailor ─── публічна стрічка RSS кар'єрного сайту
/**
 * JSON API Teamtailor вимагає токен компанії, а RSS кар'єрного сайту публічний (його дає сам
 * сайт). Хост буває з регіоном: Crossmint живе на `crossmint.na.teamtailor.com`, тож слаг тут
 * «crossmint.na». Вилка лише в тексті опису («Base salary range: $185,000 - $220,000»).
 */
export async function fetchTeamtailor(rawSlug: string, name: string, o: FetchOptions = {}): Promise<RawJob[]> {
  const labels = rawSlug.split(".");
  if (labels.length > 2) throw new Error(`teamtailor: неприпустимий slug «${rawSlug.slice(0, 40)}»`);
  const host = labels.map((l) => hostSlug(l, "teamtailor")).join(".");
  const xml = await fetchXml(`https://${host}.teamtailor.com/jobs.rss`, {}, o);
  return parseTeamtailorRss(xml, host, name);
}

const xmlText = (block: string, tag: string): string => {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(block);
  return m ? m[1]!.replace(/<!\[CDATA\[|\]\]>/g, "").trim() : "";
};
const unescapeXml = (v: string): string =>
  v.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&amp;/g, "&");

export function parseTeamtailorRss(xml: string, host: string, name: string): RawJob[] {
  const out: RawJob[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const b = m[1]!;
    const title = unescapeXml(xmlText(b, "title"));
    const url = xmlText(b, "link");
    if (!title || !/^https:\/\//.test(url)) continue;
    const cities = [...b.matchAll(/<tt:city>([\s\S]*?)<\/tt:city>/g)].map((c) => unescapeXml(c[1]!.trim())).filter(Boolean);
    const status = xmlText(b, "remoteStatus").toLowerCase();
    const location = [...new Set(cities)].slice(0, 3).join(", ") || null;
    const text = unescapeXml(xmlText(b, "description")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    out.push({
      url, company: name, title, location,
      remote: status === "fully" || status === "remote" || (!location && REMOTE.test(title)),
      postedAt: iso(xmlText(b, "pubDate")), source: `teamtailor:${host}`, crypto: true,
      description: text || null,
    });
  }
  return out;
}

// ── Breezy HR ─────────────────────────────────────────────────
export async function fetchBreezy(rawSlug: string, name: string, o: FetchOptions = {}): Promise<RawJob[]> {
  const slug = hostSlug(rawSlug, "breezy");
  const rows = await fetchJson<Array<{ name: string; url: string; published_date?: string; location?: { city?: string; country?: { name?: string }; is_remote?: boolean } }>>(
    `https://${slug}.breezy.hr/json`, {}, o);
  return withCrypto(rows.map((j) => {
    const loc = [j.location?.city, j.location?.country?.name].filter(Boolean).join(", ") || null;
    return { url: j.url, company: name, title: j.name, location: loc,
      remote: j.location?.is_remote === true || REMOTE.test(loc ?? ""),
      postedAt: iso(j.published_date), source: `breezy:${slug}` };
  }));
}

// ── Rippling ──────────────────────────────────────────────────
export async function fetchRippling(slug: string, name: string, o: FetchOptions = {}): Promise<RawJob[]> {
  const s = hostSlug(slug, "rippling");
  const rows = await fetchJson<Array<{ name: string; url: string; workLocation?: { label?: string } }>>(
    `https://api.rippling.com/platform/api/ats/v1/board/${s}/jobs`, {}, o);
  return withCrypto(rows.map((j) => {
    const loc = j.workLocation?.label ?? null;
    // Дати публікації цей ендпоінт не віддає.
    return { url: j.url, company: name, title: j.name, location: loc,
      remote: REMOTE.test(loc ?? ""), postedAt: null, source: `rippling:${s}` };
  }));
}

// ── Personio ─── XML, не JSON
export async function fetchPersonio(rawSlug: string, name: string, o: FetchOptions = {}): Promise<RawJob[]> {
  const slug = hostSlug(rawSlug, "personio");
  const xml = await fetchXml(`https://${slug}.jobs.personio.de/xml`, {}, o);
  const jobs: RawJob[] = [];
  for (const m of xml.matchAll(/<position>([\s\S]*?)<\/position>/g)) {
    const b = m[1]!;
    const id = xmlText(b, "id"); const title = unescapeXml(xmlText(b, "name"));
    if (!id || !title) continue;
    const loc = xmlText(b, "office") || null;
    jobs.push({ url: `https://${slug}.jobs.personio.de/job/${encodeURIComponent(id)}`, company: name, title,
      location: loc, remote: REMOTE.test(`${loc ?? ""} ${title}`),
      postedAt: iso(xmlText(b, "createdAt")), source: `personio:${slug}`, crypto: true });
  }
  return jobs;
}

// ── BambooHR ──────────────────────────────────────────────────
export async function fetchBambooHr(rawSlug: string, name: string, o: FetchOptions = {}): Promise<RawJob[]> {
  const slug = hostSlug(rawSlug, "bamboohr");
  const p = await fetchJson<{ result?: Array<{ id: string; jobOpeningName: string;
    location?: { city?: string; state?: string; country?: string }; isRemote?: boolean }> }>(
    `https://${slug}.bamboohr.com/careers/list`, {}, o);
  return withCrypto((p.result ?? []).map((j) => {
    const loc = [j.location?.city, j.location?.state, j.location?.country].filter(Boolean).join(", ") || null;
    // Дати відкриття вакансії цей ендпоінт не віддає взагалі.
    return { url: `https://${slug}.bamboohr.com/careers/${encodeURIComponent(String(j.id))}`, company: name,
      title: j.jobOpeningName, location: loc, remote: j.isRemote === true || REMOTE.test(loc ?? ""),
      postedAt: null, source: `bamboohr:${slug}` };
  }));
}

// ── Gem ─── публічний Job Board API (форма як у Greenhouse), слаг = «vanity path» дошки jobs.gem.com
export async function fetchGem(slug: string, name: string, o: FetchOptions = {}): Promise<RawJob[]> {
  const s = hostSlug(slug, "gem");
  const posts = await fetchJson<Array<{ title: string; absolute_url: string; location?: { name?: string } | null;
    location_type?: string | null; first_published_at?: string | null; created_at?: string | null;
    content_plain?: string | null; pay_input_ranges?: GreenhouseRange[] | null }>>(
    `https://api.gem.com/job_board/v0/${s}/job_posts/`, {}, o);
  return withCrypto(posts.map((j) => {
    const loc = j.location?.name ?? null;
    return { url: j.absolute_url, company: name, title: j.title, location: loc,
      remote: j.location_type === "remote" || REMOTE.test(loc ?? ""),
      postedAt: iso(j.first_published_at ?? j.created_at), source: `gem:${s}`,
      description: j.content_plain ?? null, ...greenhousePay(j.pay_input_ranges) };
  }));
}

// ── Pinpoint ─── `postings.json` кар'єрного сайту, вилка окремими полями
export async function fetchPinpoint(rawSlug: string, name: string, o: FetchOptions = {}): Promise<RawJob[]> {
  const slug = hostSlug(rawSlug, "pinpoint");
  const p = await fetchJson<{ data?: Array<{ title: string; url: string; location?: { name?: string | null; city?: string | null } | null;
    workplace_type?: string | null; description?: string | null; compensation_visible?: boolean;
    compensation_minimum?: number | null; compensation_maximum?: number | null;
    compensation_currency?: string | null; compensation_frequency?: string | null }> }>(
    `https://${slug}.pinpointhq.com/postings.json`, {}, o);
  return withCrypto((p.data ?? []).map((j) => {
    const loc = j.location?.name ?? j.location?.city ?? null;
    const shown = j.compensation_visible !== false;
    // Дати публікації ця стрічка не віддає (лише deadline_at).
    return { url: j.url, company: name, title: j.title, location: loc,
      remote: j.workplace_type === "remote" || REMOTE.test(loc ?? ""), postedAt: null, source: `pinpoint:${slug}`,
      description: j.description?.replace(/<[^>]+>/g, " ") ?? null,
      ...(shown ? payFor(j.compensation_minimum ?? null, j.compensation_maximum ?? null,
        currencyCode(j.compensation_currency), payPeriod(j.compensation_frequency)) : {}) };
  }));
}

// ── HiBob ─── API кар'єрного сайту: компанію називає заголовок `companyidentifier`
export async function fetchHiBob(rawSlug: string, name: string, o: FetchOptions = {}): Promise<RawJob[]> {
  const slug = hostSlug(rawSlug, "hibob");
  const p = await fetchJson<{ jobAdDetails?: Array<{ id: string; title: string; site?: string | null; country?: string | null;
    workspaceTypeId?: string | null; publishedAt?: string | null; description?: string | null;
    payTransparencyMinSalary?: number | null; payTransparencyMaxSalary?: number | null;
    payTransparencySalaryCurrency?: string | null; payTransparencySalaryPayPeriod?: string | null }> }>(
    `https://${slug}.careers.hibob.com/api/job-ad`, { headers: { companyidentifier: slug } }, o);
  return withCrypto((p.jobAdDetails ?? []).map((j) => {
    const loc = [j.site?.replace(/-/g, " "), j.country].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(", ") || null;
    return { url: `https://${slug}.careers.hibob.com/jobs/${encodeURIComponent(j.id)}`, company: name, title: j.title,
      location: loc, remote: j.workspaceTypeId === "remote" || REMOTE.test(loc ?? ""),
      postedAt: iso(j.publishedAt), source: `hibob:${slug}`,
      description: j.description?.replace(/<[^>]+>/g, " ") ?? null,
      ...payFor(j.payTransparencyMinSalary ?? null, j.payTransparencyMaxSalary ?? null,
        currencyCode(j.payTransparencySalaryCurrency), payPeriod(j.payTransparencySalaryPayPeriod)) };
  }));
}

// ── Comeet ─── Careers API; слаг «<uid компанії>.<публічний токен>» (токен стоїть на її кар'єрній сторінці)
const COMEET_SLUG = /^([0-9A-F]{2}\.[0-9A-F]{3})\.([0-9A-F]{16,64})$/i;
export function comeetSlug(slug: string): { uid: string; token: string } {
  const m = COMEET_SLUG.exec(slug);
  if (!m) throw new Error(`comeet: неприпустимий slug «${slug.slice(0, 40)}»`);
  return { uid: m[1]!.toUpperCase(), token: m[2]!.toUpperCase() };
}

export async function fetchComeet(slug: string, name: string, o: FetchOptions = {}): Promise<RawJob[]> {
  const { uid, token } = comeetSlug(slug);
  const posts = await fetchJson<Array<{ name: string; url_comeet_hosted_page?: string | null; url_active_page?: string | null;
    workplace_type?: string | null; time_updated?: string | null;
    location?: { city?: string | null; country?: string | null; is_remote?: boolean } | null }>>(
    `https://www.comeet.co/careers-api/2.0/company/${uid}/positions?token=${token}&details=false`, {}, o);
  return withCrypto(posts.filter((j) => j.url_comeet_hosted_page || j.url_active_page).map((j) => {
    const loc = [j.location?.city, j.location?.country].filter(Boolean).join(", ") || null;
    // Лише час останньої правки: дати публікації Comeet не віддає.
    return { url: (j.url_comeet_hosted_page ?? j.url_active_page)!, company: name, title: j.name, location: loc,
      remote: /remote/i.test(j.workplace_type ?? "") || REMOTE.test(loc ?? ""),
      postedAt: iso(j.time_updated), source: `comeet:${uid}` };
  }));
}

// ── Workday ─── JSON кар'єрного сайту (cxs); слаг «<tenant>.<wdN>.<site>»
const WORKDAY_SLUG = /^([a-z0-9][a-z0-9-]{0,62})\.(wd\d{1,3})\.([a-z0-9][a-z0-9_-]{0,62})$/i;
export function workdaySlug(slug: string): { tenant: string; wd: string; site: string } {
  const m = WORKDAY_SLUG.exec(slug);
  if (!m) throw new Error(`workday: неприпустимий slug «${slug.slice(0, 40)}»`);
  return { tenant: m[1]!.toLowerCase(), wd: m[2]!.toLowerCase(), site: m[3]! };
}

/** «Posted Today / Yesterday / 3 Days Ago»; «30+ Days Ago» точної дати не має. */
export function workdayPosted(text: string | null | undefined, now = new Date()): string | null {
  const t = (text ?? "").toLowerCase();
  const days = /today/.test(t) ? 0 : /yesterday/.test(t) ? 1 : /\+/.test(t) ? null : Number(/(\d+)\s+days?/.exec(t)?.[1] ?? NaN);
  if (days === null || !Number.isFinite(days)) return null;
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

const WORKDAY_PAGE = 20;
const WORKDAY_MAX_PAGES = 10;

export async function fetchWorkday(slug: string, name: string, o: FetchOptions = {}): Promise<RawJob[]> {
  const { tenant, wd, site } = workdaySlug(slug);
  const host = `https://${tenant}.${wd}.myworkdayjobs.com`;
  const out: RawJob[] = [];
  for (let page = 0; page < WORKDAY_MAX_PAGES; page++) {
    const p = await fetchJson<{ jobPostings?: Array<{ title?: string; externalPath?: string; locationsText?: string; postedOn?: string }> }>(
      `${host}/wday/cxs/${tenant}/${site}/jobs`,
      { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ appliedFacets: {}, limit: WORKDAY_PAGE, offset: page * WORKDAY_PAGE, searchText: "" }) }, o);
    const rows = p.jobPostings ?? [];
    for (const j of rows) {
      if (!j.title || !j.externalPath?.startsWith("/")) continue;
      const loc = j.locationsText && !/^\d+ locations?$/i.test(j.locationsText) ? j.locationsText : null;
      out.push({ url: `${host}/${site}${j.externalPath}`, company: name, title: j.title, location: loc,
        remote: REMOTE.test(`${loc ?? ""} ${j.title}`), postedAt: workdayPosted(j.postedOn),
        source: `workday:${tenant}.${wd}.${site}`, crypto: true });
    }
    if (rows.length < WORKDAY_PAGE) break;
  }
  return out;
}

export type AtsFetcher = (slug: string, name: string, o?: FetchOptions) => Promise<RawJob[]>;

export const ATS: Record<AtsProvider, AtsFetcher> = {
  greenhouse: fetchGreenhouse,
  lever: fetchLever,
  lever_eu: fetchLeverEu,
  ashby: fetchAshby,
  workable: fetchWorkable,
  smartrecruiters: fetchSmartRecruiters,
  recruitee: fetchRecruitee,
  teamtailor: fetchTeamtailor,
  breezy: fetchBreezy,
  rippling: fetchRippling,
  personio: fetchPersonio,
  bamboohr: fetchBambooHr,
  gem: fetchGem,
  pinpoint: fetchPinpoint,
  hibob: fetchHiBob,
  comeet: fetchComeet,
  workday: fetchWorkday,
};

/** Ключ джерела в jobs_cache.source і source_state: `<провайдер>:<слаг>`, як пишуть fetch* вище. */
export function atsSourceKey(provider: AtsProvider, atsSlug: string): string {
  // Comeet: токен у ключ не йде (ключ видно в адмінці й журналі); Workday: назва сайту чутлива до регістру.
  if (provider === "comeet") return `comeet:${comeetSlug(atsSlug).uid}`;
  if (provider === "workday") { const w = workdaySlug(atsSlug); return `workday:${w.tenant}.${w.wd}.${w.site}`; }
  return `${provider}:${["greenhouse", "lever", "lever_eu", "ashby"].includes(provider) ? atsSlug : atsSlug.toLowerCase()}`;
}
