// Перенесено з NextRole (crypto-jobs-agent, scanner): src/sources/getro.ts (fetchGetro, mapIndustries,
// extractAts). Тут лише для щотижневої розвідки посилань на ATS; вакансій з Getro в базі немає.
/**
 * Умови Getro (https://www.getro.com/terms, версія 3.1, червень 2025) забороняють те, що «crawls,
 * scrapes, or spiders any page, data, or portion of or relating to the Services». Власник 14.09.2026
 * прийняв ризик малого обсягу (engine/deploy/README.md §8, «Дошки екосистем і фондів»):
 * - щоденний скан Getro не читає зовсім;
 * - щотижнева розвідка (discover.ts, JOBS_GETRO_DISCOVERY=1) проходить кожну дошку з реєстру
 *   job_boards ОДИН раз, по запиту раз на 1,5 с: список компаній дошки (fetchGetroCompanies), а для
 *   компанії з вакансіями, якої реєстр не знає, одна сторінка її вакансій (fetchGetroOrgLinks), з якої
 *   береться тільки адреса, куди вакансії ведуть (ATS чи сторінка кар'єри роботодавця). Назви, тексти,
 *   зарплати Getro ніде не зберігаються й не показуються; вакансії йдуть з публічного API ATS роботодавця.
 * fetchGetroLinks (усі вакансії колекції) розвідка більше не викликає: лишився для разових перевірок.
 */
import { fetchJson, SourceUnavailableError, type FetchOptions } from "../../http.js";
import type { AtsProvider } from "../types.js";

interface GetroJob {
  url?: string;
  /** 'career_page': Getro зняв вакансію зі сторінки роботодавця; 'admin_portal': її вписали прямо в Getro. */
  source?: string;
  organization?: { id?: number; name?: string; slug?: string; industry_tags?: string[]; topics?: string[] };
}

/**
 * Галузь організації за словами самого Getro (`industry_tags`, `topics`). Колекції фондів
 * охоплюють усі галузі (у портфелі Coinbase Ventures є Notion), тож для дошки з crypto_scope
 * 'tagged' крипто лише організація, про яку Getro так і каже, або без жодної галузі.
 */
const CRYPTO_INDUSTRY = /blockchain|cryptocurrenc|crypto|web3|\bnft\b|defi|digital assets?|stablecoin|bitcoin|ethereum|solana/i;

export type OrgIndustry = "crypto" | "other" | "unknown";

export function orgIndustry(org: GetroJob["organization"]): OrgIndustry {
  const text = [...(org?.industry_tags ?? []), ...(org?.topics ?? [])].join(" ");
  if (!text.trim()) return "unknown";
  return CRYPTO_INDUSTRY.test(text) ? "crypto" : "other";
}

export interface GetroLink {
  url: string;
  company: string;
  industry: OrgIndustry;
  /** id організації в Getro: одна компанія під різними назвами вакансій. */
  orgId?: number | null;
  /** Вакансію вписали прямо в Getro (своєї сторінки чи ATS у роботодавця для неї немає). */
  hosted?: boolean;
}

const MAX_PAGES = 200;
/** Getro віддає рівно двадцять на сторінку й ігнорує `hitsPerPage`. */
const PER_PAGE = 20;

/** Вакансія живе лише на самій дошці Getro: так її позначає Getro або так каже адреса. */
export function isGetroHosted(url: string, source: string | undefined, boardHost?: string | null): boolean {
  if (source === "admin_portal") return true;
  let host: string;
  try { host = new URL(url).hostname.toLowerCase(); } catch { return false; }
  if (host === "getro.com" || host.endsWith(".getro.com")) return true;
  return !!boardHost && host === boardHost.toLowerCase();
}

/**
 * Посилання вакансій колекції. Пауза між сторінками: Getro тротлить агресивно, і 429 посеред
 * гортання лишає прочитане (перша сторінка без відповіді означає, що колекції цього разу немає).
 */
export async function fetchGetroLinks(collectionId: number, o: FetchOptions = {}, pages = MAX_PAGES,
                                      pauseMs = 600, boardHost: string | null = null): Promise<GetroLink[]> {
  const out: GetroLink[] = [];
  let limit = pages;
  for (let page = 0; page < limit; page++) {
    if (page > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    let p: { results?: { jobs?: GetroJob[]; count?: number } };
    try {
      p = await fetchJson<{ results?: { jobs?: GetroJob[]; count?: number } }>(
        `https://api.getro.com/api/v2/collections/${collectionId}/search/jobs`,
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page, hitsPerPage: PER_PAGE, filters: {} }) }, o);
    } catch (e) {
      if (page > 0 && e instanceof SourceUnavailableError && e.status === 429) break;
      throw e;
    }
    const batch = p.results?.jobs ?? [];
    if (batch.length === 0) break;
    if (page === 0) {
      const count = p.results?.count;
      if (typeof count === "number" && count > 0) limit = Math.min(pages, Math.ceil(count / PER_PAGE));
    }
    for (const j of batch) {
      if (!j.url) continue;
      out.push({ url: j.url, company: j.organization?.name ?? "", industry: orgIndustry(j.organization),
        orgId: typeof j.organization?.id === "number" ? j.organization.id : null,
        hosted: isGetroHosted(j.url, j.source, boardHost) });
    }
  }
  return out;
}

/** Організація дошки за списком компаній Getro (без вакансій). */
export interface GetroCompany { id: number; name: string; activeJobs: number; industry: OrgIndustry; domain: string | null }

/** Getro віддає компанії по дванадцять на сторінку, що б не просили. */
const COMPANIES_PER_PAGE = 12;

/**
 * Список компаній дошки (`search/companies`): назва, галузь і скільки в неї відкритих вакансій. Саме
 * він і є «розвідка компаній»: вакансії дошки розвідка читає лише для компанії, якої реєстр ще не знає
 * (fetchGetroOrgLinks), тож за тиждень це кілька десятків сторінок, а не всі вакансії дошки.
 */
export async function fetchGetroCompanies(collectionId: number, o: FetchOptions = {}, pages = 50, pauseMs = 600): Promise<GetroCompany[]> {
  const out: GetroCompany[] = [];
  let limit = pages;
  for (let page = 0; page < limit; page++) {
    if (page > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
    let p: { results?: { companies?: Array<{ id?: number; name?: string; active_jobs_count?: number; domain?: string | null;
      industry_tags?: string[]; topics?: string[] }>; count?: number } };
    try {
      p = await fetchJson(`https://api.getro.com/api/v2/collections/${collectionId}/search/companies`,
        { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ page, hitsPerPage: COMPANIES_PER_PAGE, filters: {} }) }, o);
    } catch (e) {
      if (page > 0 && e instanceof SourceUnavailableError && e.status === 429) break;
      throw e;
    }
    const batch = p.results?.companies ?? [];
    if (batch.length === 0) break;
    if (page === 0) {
      const count = p.results?.count;
      if (typeof count === "number" && count > 0) limit = Math.min(pages, Math.ceil(count / COMPANIES_PER_PAGE));
    }
    for (const c of batch) {
      if (typeof c.id !== "number" || !c.name?.trim()) continue;
      out.push({ id: c.id, name: c.name.replace(/\s+/g, " ").trim(), activeJobs: Number(c.active_jobs_count) || 0,
        industry: orgIndustry(c), domain: c.domain ?? null });
    }
  }
  return out;
}

/**
 * Адреси вакансій однієї організації дошки: одна сторінка (до двадцяти) з фільтром `organization.id`.
 * Беремо лише організацію й адресу, як і fetchGetroLinks.
 */
export async function fetchGetroOrgLinks(collectionId: number, orgId: number, o: FetchOptions = {},
                                         boardHost: string | null = null): Promise<GetroLink[]> {
  const p = await fetchJson<{ results?: { jobs?: GetroJob[] } }>(
    `https://api.getro.com/api/v2/collections/${collectionId}/search/jobs`,
    { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ page: 0, hitsPerPage: PER_PAGE, filters: { "organization.id": [orgId] } }) }, o);
  return (p.results?.jobs ?? []).filter((j) => j.url).map((j) => ({
    url: j.url!, company: j.organization?.name ?? "", industry: orgIndustry(j.organization),
    orgId: typeof j.organization?.id === "number" ? j.organization.id : orgId, hosted: isGetroHosted(j.url!, j.source, boardHost) }));
}

/** Що каже сама сторінка дошки: платформа й, для Getro, номер колекції (реєстр job_boards). */
export interface BoardPage {
  platform: "getro" | "consider" | "pallet" | "unknown";
  getro: { id: number; name: string | null; kind: string | null; host: string | null } | null;
}

/**
 * Платформа дошки за її сторінкою. Getro: Next.js-сторінка, де `props.pageProps.network.id` і є
 * номер колекції. Consider і Pallet пізнаються за своїми адресами в розмітці.
 */
export function parseBoardPage(html: string): BoardPage {
  const m = /<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/.exec(html);
  if (m?.[1]) {
    try {
      const d = JSON.parse(m[1]) as { props?: { pageProps?: { network?: { id?: string | number; name?: string; kind?: string; url?: string } } } };
      const n = d.props?.pageProps?.network;
      const id = Number(n?.id);
      if (n && Number.isInteger(id) && id > 0) {
        return { platform: "getro", getro: { id, name: n.name ?? null, kind: n.kind ?? null, host: n.url ?? null } };
      }
    } catch { /* не JSON: далі за адресами */ }
  }
  if (/consider\.com/i.test(html)) return { platform: "consider", getro: null };
  if (/pallet\.(?:com|xyz)/i.test(html)) return { platform: "pallet", getro: null };
  return { platform: "unknown", getro: null };
}

/**
 * ATS і слаг із посилання на вакансію. Поправки 13.09.2026, кожна з живого посилання: крапка й %20
 * у слагу Ashby (`kraken.com`, `Sui%20Foundation`), вбудована форма Greenhouse (`?for=`),
 * Recruitee, європейський Lever. Teamtailor додано тут (хост буває з регіоном: `x.na.teamtailor.com`).
 * 14.09.2026: хост Personio `.com` з будь-яким шляхом, BambooHR `/jobs/`, SmartRecruiters `careers.`,
 * Workable на піддомені компанії (`io-global.workable.com`), API-адреси Greenhouse, Lever і Ashby.
 */
const ATS_PATTERNS: Array<[AtsProvider, RegExp]> = [
  ["greenhouse", /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/embed\/job_(?:app|board)(?:\/js)?\?(?:[^#"'\s]*?&(?:amp;)?)?for=([a-z0-9_-]+)/i],
  ["greenhouse", /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?!embed\/)([a-z0-9_-]+)/i],
  ["greenhouse", /boards-api\.greenhouse\.io\/v1\/boards\/([a-z0-9_-]+)/i],
  ["lever", /\/\/jobs\.lever\.co\/([a-z0-9_-]+)/i],
  ["lever", /\/\/api\.lever\.co\/v0\/postings\/([a-z0-9_-]+)/i],
  ["lever_eu", /\/\/jobs\.eu\.lever\.co\/([a-z0-9_-]+)/i],
  ["ashby", /jobs\.ashbyhq\.com\/([a-z0-9_.%-]+?)(?:[/?#"'\s]|$)/i],
  ["ashby", /api\.ashbyhq\.com\/posting-api\/job-board\/([a-z0-9_.%-]+?)(?:[/?#"'\s]|$)/i],
  ["workable", /apply\.workable\.com\/(?!api\/)([a-z0-9_-]+)/i],
  ["workable", /\/\/(?!apply\.|www\.|jobs\.)([a-z0-9-]+)\.workable\.com/i],
  ["smartrecruiters", /(?:jobs|careers)\.smartrecruiters\.com\/([a-z0-9_-]+)/i],
  ["breezy", /\/\/([a-z0-9_-]+)\.breezy\.hr/i],
  ["rippling", /ats\.rippling\.com\/([a-z0-9_-]+)/i],
  ["personio", /\/\/([a-z0-9_-]+)\.jobs\.personio\.(?:de|com)/i],
  ["bamboohr", /\/\/([a-z0-9_-]+)\.bamboohr\.com\/(?:careers|jobs)/i],
  ["recruitee", /\/\/([a-z0-9_-]+)\.recruitee\.com\/o\//i],
  ["teamtailor", /\/\/([a-z0-9-]+(?:\.(?:na|eu))?)\.teamtailor\.com\/jobs/i],
];

/** Слова, що стоять на місці слага в службових адресах ATS, а не назва дошки. */
const NOT_A_SLUG = new Set(["embed", "jobs", "api", "v0", "v1", "www", "app", "careers", "static", "assets", "js", "css", "widget"]);

export function extractAts(url: string): { provider: AtsProvider; slug: string } | null {
  for (const [provider, rx] of ATS_PATTERNS) {
    const m = rx.exec(url);
    if (!m?.[1] || NOT_A_SLUG.has(m[1].toLowerCase())) continue;
    // Слаг Ashby чутливий до регістру (Sui%20Foundation): лишаємо як є, решта в нижньому.
    return { provider, slug: provider === "ashby" ? m[1] : m[1].toLowerCase() };
  }
  return null;
}

/**
 * ATS, яких скан не читає (немає публічного API або воно закрите): лише для звіту розвідки, щоб
 * було видно, чому компанію не взято.
 */
const OTHER_ATS: Array<[string, RegExp]> = [
  ["workday", /myworkdayjobs\.com|\.wd\d\.myworkday/i], ["jobvite", /jobvite\.com/i], ["icims", /icims\.com/i],
  ["screenloop", /screenloop\.com/i], ["gem", /jobs\.gem\.com/i], ["dover", /dover\.(?:com|io)/i],
  ["wellfound", /wellfound\.com|angel\.co/i], ["notion", /notion\.(?:site|so|com)/i], ["hibob", /hibob\.com/i],
  ["pinpoint", /pinpointhq\.com/i], ["comeet", /comeet\.(?:com|co)/i], ["jazzhr", /applytojob\.com/i],
  ["zoho", /zohorecruit/i], ["polymer", /polymer\.co/i], ["homerun", /homerun\.co/i], ["join", /join\.com\//i],
  ["factorial", /factorialhr/i], ["welcometothejungle", /welcometothejungle/i], ["linkedin", /linkedin\.com/i],
  ["ycombinator", /ycombinator\.com|workatastartup/i], ["freshteam", /freshteam\.com/i], ["keka", /keka\.com/i],
  ["manatal", /manatal\.com/i], ["trakstar", /recruiterbox|trakstar/i], ["oracle", /oraclecloud\.com/i],
  ["successfactors", /successfactors|sapsf/i], ["taleo", /taleo\.net/i], ["rippling-other", /rippling\.com\/(?!.*ats)/i],
  ["google-forms", /docs\.google\.com|forms\.gle/i], ["typeform", /typeform\.com/i], ["tally", /tally\.so/i],
  ["jobboardly", /jobboardly|careerspage\.io|jobboardfire/i], ["crypto-board", /cryptojobslist|web3\.career|cryptocurrencyjobs/i],
];

export type LinkKind =
  | { kind: "ats"; provider: AtsProvider; slug: string }
  | { kind: "hosted" }
  | { kind: "other-ats"; name: string }
  | { kind: "career-page"; host: string };

/** Куди веде посилання вакансії: ATS, який скан читає; сама дошка; інший ATS; сторінка роботодавця. */
export function classifyLink(link: Pick<GetroLink, "url" | "hosted">): LinkKind {
  if (link.hosted) return { kind: "hosted" };
  const hit = extractAts(link.url);
  if (hit) return { kind: "ats", ...hit };
  for (const [name, rx] of OTHER_ATS) if (rx.test(link.url)) return { kind: "other-ats", name };
  try {
    return { kind: "career-page", host: new URL(link.url).hostname.toLowerCase().replace(/^www\./, "") };
  } catch {
    return { kind: "other-ats", name: "bad-url" };
  }
}
