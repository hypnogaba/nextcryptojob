// Перенесено з попереднього проєкту (сканер): src/sources/boards.ts, лише три формати, якими
// читаються крипто-дошки: розмітка JobPosting, потік Next.js (JobStash), RSS (remote3).
// Національних дошок і розбору їхніх заголовків тут немає.
//
// web3.career тут НЕ читається: з 14.09.2026 лише їхній офіційний API з токеном (web3career.ts), а
// fetchBoard відмовляє будь-якій адресі web3.career, щоб сторінки не збирались удруге. З 17.09.2026
// так само закрито jobstash.xyz: його власник попросив припинити читання (BLOCKED_BOARDS). Розбір
// розмітки JobPosting лишився для інших дошок; знімок web3career-list.html лише зразок розмітки.
import { fetchXml, type FetchOptions } from "../../http.js";
import { extractSalary } from "../salary-text.js";
import { mapLimit } from "../run.js";
import type { BoardSource, RawJob } from "../types.js";
import { MAX_YEARLY, MIN_YEARLY } from "../pay.js";

const iso = (v: string): string | null => {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

const decode = (v: string): string =>
  v.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
   .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
   .replace(/&#(\d+);/g, (all: string, n: string) => {
     // fromCodePoint кидає на &#99999999;: одна така сутність у чужій стрічці валила б усю дошку.
     const cp = Number(n);
     return Number.isFinite(cp) && cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : all;
   });

/** Заголовок довший за це не заголовок; ріжемо ДО регулярок. */
const TITLE_MAX = 300;

const str = (v: unknown): string =>
  typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";

/** Позначка віддаленості всередині рядка локації: «Remote, USA». */
const REMOTE_ANYWHERE = /remote|anywhere|distributed|télétravail|worldwide/i;

/**
 * Рядок, який дошка не мала показувати нікому. У живій стрічці Remote3 лежали їхні тестові
 * записи («__probe_job__ at undefined», посилання на `/remote-jobs/null`), і два доїхали до кешу.
 */
export function isJunk(text: string, link: string): boolean {
  const t = text.trim();
  if (!t) return true;
  if (/^__.*__$/.test(t)) return true;
  if (/(^|\s)__[a-z0-9_]+__(\s|$)/i.test(t)) return true;
  if (/^(undefined|null|nan|none|n\/a|test)$/i.test(t)) return true;
  if (/\b(undefined|__probe|__repro|__xss)\b/i.test(t)) return true;
  if (link && /\/(null|undefined)\/?$/i.test(link)) return true;
  return false;
}

/** Прибирає мітки переходів: без цього та сама вакансія з двох прогонів мала б дві адреси. */
export function cleanUrl(raw: string): string {
  try {
    const u = new URL(raw.trim());
    for (const k of [...u.searchParams.keys()]) if (k.startsWith("utm_")) u.searchParams.delete(k);
    return u.toString();
  } catch { return raw.trim(); }
}

/**
 * «Роль at Компанія» (remote3) або «Компанія: Роль». Ділимо по ОСТАННЬОМУ « at »: воно трапляється
 * в назві посади. Remote3 пише компанію двічі («Job Application for MLRO at Bybit at Bybit»),
 * тож друга копія прибирається з назви.
 */
export function splitBoardTitle(raw: string): { company: string; title: string } | null {
  const clean = decode(raw.slice(0, TITLE_MAX)).replace(/\s+/g, " ").trim();
  if (!clean) return null;
  const atCut = clean.toLowerCase().lastIndexOf(" at ");
  if (atCut > 0) {
    const company = clean.slice(atCut + 4).trim().replace(/[.,]$/, "");
    let title = clean.slice(0, atCut).trim().replace(/\s+job$/i, "");
    if (title.toLowerCase().endsWith(` at ${company.toLowerCase()}`)) title = title.slice(0, -(company.length + 4)).trim();
    title = title.replace(/^job application for\s+/i, "");
    if (company && title && company.length <= 60) return { company, title };
  }
  const colon = /^(.+?)\s*[:|–\u2014]\s*(.+)$/.exec(clean);
  if (colon && colon[1]!.length <= 60) return { company: colon[1]!.trim(), title: colon[2]!.trim() };
  return null;
}

/** Хост web3.career: вакансії з нього лише через офіційний API (web3career.ts). */
export function isWeb3CareerHost(url: string): boolean {
  try { return /(^|\.)web3\.career$/i.test(new URL(url).hostname); } catch { return false; }
}

/**
 * Дошки, сторінок яких сканер не читає НІКОЛИ, хоч би що казав реєстр. Причина в кожної своя,
 * наслідок один: рядок у `sources` можна помилково ввімкнути, а запиту все одно не буде.
 */
const BLOCKED_BOARDS: ReadonlyArray<{ host: RegExp; why: string }> = [
  { host: /(^|\.)web3\.career$/i, why: "web3.career читається лише через офіційний API (web3career.ts), не сторінками" },
  // 17.09.2026 власник JobStash написав нам, що не хоче, щоб ми читали його дошку. Рішення власника
  // NextCryptoJob того ж дня: джерело вимкнено, його вакансії з бази видалено, запитів більше немає.
  { host: /(^|\.)jobstash\.xyz$/i, why: "jobstash.xyz: власник дошки попросив припинити 17.09.2026, джерело закрито назавжди" },
];

/** Причина відмови для цієї адреси, або null, якщо дошку читати можна. */
export function blockedBoardReason(url: string): string | null {
  let host: string;
  try { host = new URL(url).hostname; } catch { return null; }
  return BLOCKED_BOARDS.find((b) => b.host.test(host))?.why ?? null;
}

export async function fetchBoard(board: BoardSource, windowDays: number, o: FetchOptions = {}, now: Date = new Date()): Promise<RawJob[]> {
  const blocked = blockedBoardReason(board.feedUrl);
  if (blocked) throw new Error(`${board.name}: ${blocked}`);
  if (board.kind === "jsonld") return fetchJsonLd(board, o, windowDays, now);
  if (board.kind === "nextjs") return fetchNextBoard(board, o, windowDays, now);
  if (board.kind === "rss") return fetchRss(board, o);
  throw new Error(`формат «${board.kind}» не для fetchBoard: ${board.name}`);
}

// ── RSS (remote3) ─────────────────────────────────────────────
const rssItems = (xml: string): Array<{ title: string; link: string; date: string; description: string }> =>
  [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => {
    const b = m[1]!;
    const get = (t: string): string => {
      const r = new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`).exec(b);
      return r ? r[1]!.replace(/<!\[CDATA\[|\]\]>/g, "").replace(/<[^>]+>/g, " ").trim() : "";
    };
    return { title: get("title"), link: get("link"), date: get("pubDate"), description: get("description") };
  });

/**
 * Опис remote3: «at Ihsan - Full-Time - Worldwide - $120k - $240k /yr». Місце третім шматком,
 * вилку бере extractSalary з усього рядка (/yr означає рік).
 */
export function parseRssBoard(xml: string, board: BoardSource): RawJob[] {
  const out: RawJob[] = [];
  for (const it of rssItems(xml)) {
    if (!it.link || !it.title || isJunk(it.title, it.link)) continue;
    const p = splitBoardTitle(it.title);
    if (!p || isJunk(p.company, "")) continue;
    const desc = decode(it.description);
    const parts = desc.split(/\s+-\s+/).map((s) => s.trim());
    const place = parts[2] && !/\$|€|£|\d/.test(parts[2]) ? parts[2] : null;
    const pay = extractSalary(desc);
    out.push({
      url: cleanUrl(it.link), company: p.company, title: p.title,
      location: place && !/^(worldwide|global|anywhere)$/i.test(place) ? place : null,
      // Remote3 це дошка віддаленої роботи; «Worldwide» у місці теж про це.
      remote: true, postedAt: iso(it.date), source: board.name, crypto: board.cryptoOnly,
      salaryMin: pay?.min ?? null, salaryMax: pay?.max ?? null, salaryCurrency: pay?.currency ?? null,
    });
  }
  return out;
}

async function fetchRss(board: BoardSource, o: FetchOptions): Promise<RawJob[]> {
  return parseRssBoard(await fetchXml(board.feedUrl, {}, o), board);
}

// ── JSON-LD ───────────────────────────────────────────────────
/**
 * Дошка, яка віддає вакансії розміткою JobPosting (стандарт schema.org, його ставлять для Google
 * Jobs): назва, компанія, місто й дата в однакових полях у всіх, надійніше за розбір верстки.
 */
export function parseJobPostings(html: string, board: BoardSource, pageUrl?: string): RawJob[] {
  const out: RawJob[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let parsed: unknown;
    // Один зіпсований блок не має валити решту сторінки.
    try { parsed = JSON.parse(m[1]!); } catch { continue; }
    for (const node of flatten(parsed)) {
      if (node["@type"] !== "JobPosting") continue;
      // На сторінці однієї вакансії `url` опускають: вакансія і є ця сторінка.
      const url = pickUrl(node) ?? pageUrl ?? null;
      const title = str(node.title);
      if (!url || !title) continue;
      const org0 = node.hiringOrganization;
      const company0 = str(typeof org0 === "object" && org0 !== null ? (org0 as Record<string, unknown>).name : org0);
      // Ключ ширший за адресу: у списку адреси ще немає, і всі вакансії сторінки мають заглушку.
      const key = `${url}|${title}|${company0}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const loc = jobLocation(node);
      out.push({
        url, company: company0 || "Unknown company", title: decode(decode(title)),
        location: loc, remote: isRemote(node, loc), postedAt: iso(str(node.datePosted)),
        source: board.name, crypto: board.cryptoOnly, ...salaryOf(node),
        description: str(node.description).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || null,
      });
    }
  }
  return out;
}

/**
 * `jobLocationType: TELECOMMUTE` самого по собі мало: web3.career ставив його всім, включно з
 * «Office Manager» за адресою в Нью-Йорку. Конкретне місто важить більше за прапорець.
 */
function isRemote(node: Record<string, unknown>, loc: string | null): boolean {
  if (loc && REMOTE_ANYWHERE.test(loc)) return true;
  if (loc) return false;
  return node.jobLocationType === "TELECOMMUTE";
}

/** Розмітку кладуть і масивом, і в `@graph`, і в `itemListElement`. */
function flatten(v: unknown, depth = 0): Array<Record<string, unknown>> {
  if (depth > 4 || v === null || typeof v !== "object") return [];
  if (Array.isArray(v)) return v.flatMap((x) => flatten(x, depth + 1));
  const node = v as Record<string, unknown>;
  return [node, ...flatten(node["@graph"], depth + 1), ...flatten(node.itemListElement, depth + 1), ...flatten(node.item, depth + 1)];
}

function pickUrl(node: Record<string, unknown>): string | null {
  for (const key of ["url", "sameAs"]) {
    const v = str(node[key]);
    if (/^https?:\/\//i.test(v)) return v;
  }
  const id = str(node["@id"]);
  return /^https?:\/\//i.test(id) ? id : null;
}

/** Вилка з розмітки: лише річна (погодинна поруч із річними читалась би як помилка). */
function salaryOf(node: Record<string, unknown>): { salaryMin?: number; salaryMax?: number; salaryCurrency?: string } {
  const base = node.baseSalary;
  if (!base || typeof base !== "object") return {};
  const b = base as Record<string, unknown>;
  const v = b.value;
  if (!v || typeof v !== "object") return {};
  const q = v as Record<string, unknown>;
  if (String(q.unitText ?? "").toUpperCase() !== "YEAR") return {};
  // Одна вакансія на web3.career заявляла 25 мільйонів на рік: межі обов'язкові.
  const num = (x: unknown): number | undefined => {
    if (typeof x !== "number" || !Number.isFinite(x) || x <= 0) return undefined;
    const n = Math.round(x);
    return n >= MIN_YEARLY && n <= MAX_YEARLY ? n : undefined;
  };
  const min = num(q.minValue) ?? num(q.value);
  const max = num(q.maxValue);
  if (min === undefined && max === undefined) return {};
  return {
    ...(min !== undefined ? { salaryMin: min } : {}),
    ...(max !== undefined ? { salaryMax: max } : {}),
    ...(typeof b.currency === "string" && b.currency ? { salaryCurrency: b.currency } : {}),
  };
}

function jobLocation(node: Record<string, unknown>): string | null {
  const first = Array.isArray(node.jobLocation) ? node.jobLocation[0] : node.jobLocation;
  if (!first || typeof first !== "object") return null;
  const addr = (first as Record<string, unknown>).address;
  if (!addr || typeof addr !== "object") return null;
  const a = addr as Record<string, unknown>;
  return [str(a.addressLocality), str(a.addressRegion), str(a.addressCountry)].filter(Boolean).join(", ") || null;
}

/** Стеля сторінок списку за прогін: сторінка один запит і близько двох десятків вакансій. */
const JSONLD_LIST_PAGES = 200;
const JSONLD_JOBS = 4000;
/** Коли зшити розмітку з посиланнями не вдалось, кожна вакансія коштує запит: глибше не йдемо. */
const JSONLD_SLOW_PAGES = 5;
/** Нижче цієї частки свіжого на сторінці гортати далі не варто. */
const FRESH_SHARE = 0.25;

/**
 * Чи варто гортати далі. «Є бодай одна свіжа» виявилось майже «гортай завжди»: сортування не
 * строго за датою. Частка чесніша: jobstash тримає 97% свіжого й гортається далі, web3.career
 * спиняється там, де список закінчується насправді.
 */
function worthMore(jobs: RawJob[], windowDays: number, now: Date): boolean {
  if (jobs.length === 0) return false;
  const edge = now.getTime() - windowDays * 86_400_000;
  const fresh = jobs.filter((j) => !j.postedAt || new Date(j.postedAt).getTime() >= edge).length;
  return fresh / jobs.length >= FRESH_SHARE;
}

function pageUrl(feedUrl: string, page: number): string | null {
  if (page === 1) return feedUrl;
  try {
    const u = new URL(feedUrl);
    u.searchParams.set("page", String(page));
    return u.toString();
  } catch { return null; }
}

async function fetchJsonLd(board: BoardSource, o: FetchOptions, windowDays: number, now: Date): Promise<RawJob[]> {
  const out: RawJob[] = [];
  const seen = new Set<string>();
  let budget = JSONLD_LIST_PAGES;
  for (let page = 1; page <= budget && seen.size < JSONLD_JOBS; page++) {
    const url = pageUrl(board.feedUrl, page);
    if (!url) break;
    let html: string;
    try { html = await fetchXml(url, {}, o); } catch (e) { if (page === 1) throw e; break; }
    const { jobs: batch, stitched } = await jobsFromListing(html, board, o);
    if (!stitched) budget = Math.min(budget, JSONLD_SLOW_PAGES);
    if (page > 1 && !worthMore(batch, windowDays, now)) break;
    const before = seen.size;
    for (const j of batch) {
      if (seen.has(j.url)) continue;
      seen.add(j.url);
      out.push(j);
    }
    // Сторінка не додала нічого нового: список скінчився або дошка не знає `page`.
    if (seen.size === before) break;
  }
  return out.slice(0, JSONLD_JOBS);
}

/**
 * Вакансії з однієї сторінки списку. У списку (так було на web3.career) розмітка є, але БЕЗ адрес; адреса
 * вакансії складається з її назви й компанії, тож розмітку можна зшити з посиланнями за слагом
 * без жодного додаткового запиту. Не вдалось: сторінки вакансій поодинці.
 */
async function jobsFromListing(html: string, board: BoardSource, o: FetchOptions): Promise<{ jobs: RawJob[]; stitched: boolean }> {
  const complete = parseJobPostings(html, board);
  if (complete.length) return { jobs: complete, stitched: true };
  const links = jobLinks(html, board.feedUrl);
  const stitched = stitchBySlug(parseJobPostings(html, board, PLACEHOLDER), links);
  if (stitched.length) return { jobs: stitched, stitched: true };
  const jobs: RawJob[] = [];
  await mapLimit(links, 4, async (u) => {
    try {
      const job = parseJobPostings(await fetchXml(u, {}, o), board, u)[0];
      if (job) jobs.push(job);
    } catch { /* одна сторінка зі списку не вирок дошці */ }
  });
  return { jobs, stitched: false };
}

/** Адреса-заглушка для розбору списку: замінюється справжньою одразу при зшиванні. */
const PLACEHOLDER = "https://nextcryptojob.invalid/unmatched";

function slugify(text: string): string {
  return decode(decode(text)).toLowerCase()
    .replace(/[’'`]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * Зшиває розмітку з посиланнями за слагом. Потрібен збіг І назви, І компанії: «Founding Engineer»
 * буває у двох компаній. Неоднозначний збіг відкидаємо: краще не взяти, ніж повести до чужої.
 */
export function stitchBySlug(postings: RawJob[], links: string[]): RawJob[] {
  if (postings.length === 0 || links.length === 0) return [];
  const paths = links.map((l) => {
    let seg = "";
    try { seg = new URL(l).pathname.split("/").filter(Boolean)[0] ?? ""; } catch { /* лишиться порожнім */ }
    return { url: l, seg, flat: seg.replace(/-/g, "") };
  });
  const out: RawJob[] = [];
  for (const j of postings) {
    const title = slugify(j.title);
    const company = slugify(j.company).replace(/-/g, "");
    if (!title || !company) continue;
    const hit = paths.filter((p) => p.seg.startsWith(title) && p.flat.includes(company));
    if (hit.length !== 1) continue;
    out.push({ ...j, url: hit[0]!.url });
  }
  return out;
}

/** Посилання, схожі на окремі вакансії: свій домен і числовий хвіст у шляху. */
export function jobLinks(html: string, base: string): string[] {
  let host: string;
  try { host = new URL(base).hostname; } catch { return []; }
  const out = new Set<string>();
  for (const m of html.matchAll(/href=["']([^"'#?]{6,200})["']/gi)) {
    let u: URL;
    try { u = new URL(m[1]!, base); } catch { continue; }
    if (u.hostname !== host) continue;
    if (!/\/[a-z0-9][a-z0-9-]{5,}\/\d{3,}\/?$/i.test(u.pathname)) continue;
    out.add(u.toString());
  }
  return [...out];
}

// ── потік Next.js (JobStash) ──────────────────────────────────
/**
 * Дошка на Next.js кладе готові записи вакансій у `self.__next_f.push([1,"…"])`: назва, компанія,
 * її опис, місто, дата. Десять записів на один запит.
 */
export function parseNextPayload(html: string, board: BoardSource): RawJob[] {
  const out: RawJob[] = [];
  const seen = new Set<string>();
  for (const node of nextObjects(unpackNextStream(html))) {
    const title = str(node.title);
    const href = str(node.href) || str(node.url);
    if (!title || !href) continue;
    let url: string;
    try { url = new URL(href, board.feedUrl).toString(); } catch { continue; }
    if (seen.has(url)) continue;
    const org = node.organization ?? node.company;
    const company = str(typeof org === "object" && org !== null ? (org as Record<string, unknown>).name : org);
    if (!company) continue;
    seen.add(url);
    const addr = Array.isArray(node.addresses) ? node.addresses[0] : null;
    const a = addr && typeof addr === "object" ? addr as Record<string, unknown> : {};
    const location = str(node.location) || [str(a.locality), str(a.country)].filter(Boolean).join(", ") || null;
    out.push({
      url, company, title, location,
      remote: a.isRemote === true || str(node.locationType).toUpperCase() === "REMOTE" || REMOTE_ANYWHERE.test(location ?? ""),
      postedAt: iso(str(node.datePosted)), source: board.name,
      // JobStash це дошка «web3 і фінанси»: поруч Ava Labs і Optiver. Гуртовий тег збрехав би
      // на половині рядків, тож крипто лише те, що дошка сама позначила (nicheOf).
      crypto: board.cryptoOnly || isCryptoNiche(node),
      description: str(node.summary) || null,
    });
  }
  return out;
}

/** Слова, за якими впізнаємо крипто-роботодавця в тому, що сказала дошка. */
const CRYPTO_WORDS = /\b(crypto|web3|blockchain|defi|onchain|on-chain|stablecoin|digital assets?|dao|nft|token|protocol|ethereum|solana|bitcoin|layer ?2|zk|validator|staking)\b/i;

/**
 * Крипто за словом дошки: її власні теги (`tags[].name`), підписи під карткою (`infoTags[].label`)
 * і опис організації. Жодного здогаду з нашого боку.
 */
export function isCryptoNiche(node: Record<string, unknown>): boolean {
  const bits: string[] = [];
  const push = (v: unknown) => { const x = str(v); if (x) bits.push(x); };
  for (const t of Array.isArray(node.tags) ? node.tags : []) if (t && typeof t === "object") push((t as Record<string, unknown>).name);
  for (const t of Array.isArray(node.infoTags) ? node.infoTags : []) if (t && typeof t === "object") push((t as Record<string, unknown>).label);
  const org = node.organization;
  if (org && typeof org === "object") {
    const o = org as Record<string, unknown>;
    push(o.name); push(o.summary); push(o.description);
  }
  return CRYPTO_WORDS.test(bits.join(" "));
}

/** Потік Next.js суцільним текстом: шматок може обірватись посеред запису, тож склеюємо всі. */
function unpackNextStream(html: string): string {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[\d+,\s*"((?:[^"\\]|\\.)*)"\]\)/g)].map((m) => m[1]!);
  if (chunks.length === 0) return "";
  return chunks.join("").replace(/\\"/g, '"').replace(/\\\\/g, "\\")
    .replace(/\\n/g, "\n").replace(/\\u([0-9a-fA-F]{4})/g, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

const OBJECT_MAX = 12_000;

/** Об'єкти, схожі на вакансію: ознака форма (є `title` і посилання), а не назва поля. */
function* nextObjects(blob: string): Generator<Record<string, unknown>> {
  for (const m of blob.matchAll(/\{"(?:id|title|slug|jobId)"/g)) {
    const start = m.index!;
    let depth = 0;
    for (let i = start; i < Math.min(start + OBJECT_MAX, blob.length); i++) {
      const c = blob[i];
      if (c === '"') {
        i++;
        while (i < blob.length && blob[i] !== '"') i += blob[i] === "\\" ? 2 : 1;
        continue;
      }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) {
          try {
            const o: unknown = JSON.parse(blob.slice(start, i + 1));
            if (o && typeof o === "object" && !Array.isArray(o)) yield o as Record<string, unknown>;
          } catch { /* обрізаний шматок не запис */ }
          break;
        }
      }
    }
  }
}

const NEXT_PAGES = 200;

async function fetchNextBoard(board: BoardSource, o: FetchOptions, windowDays: number, now: Date): Promise<RawJob[]> {
  const out: RawJob[] = [];
  const seen = new Set<string>();
  for (let page = 1; page <= NEXT_PAGES; page++) {
    const url = pageUrl(board.feedUrl, page);
    if (!url) break;
    let batch: RawJob[];
    try { batch = parseNextPayload(await fetchXml(url, {}, o), board); } catch (e) { if (page === 1) throw e; break; }
    if (page > 1 && !worthMore(batch, windowDays, now)) break;
    const before = seen.size;
    for (const j of batch) {
      if (seen.has(j.url)) continue;
      seen.add(j.url);
      out.push(j);
    }
    if (seen.size === before) break;
  }
  return out;
}
