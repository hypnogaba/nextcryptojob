// Що відомо про роботодавця (`jobs-about [--dry]`, і щотижня після `jobs-discover`): домен для значка
// і одне-два речення про те, що компанія робить, для картки вакансії на /jobs, у листі й у Telegram.
// Стовпці companies.domain і companies.about (db/jobs/0005_company_profile.sql).
//
// Лише з джерел, які самі це віддають, і лише де дешево:
// - домен: примітка реєстру «company site https://…», слаг Ashby, що сам є доменом (kraken.com), і
//   найчастіший власний хост серед адрес вакансій компанії (Greenhouse часто веде на coinbase.com/careers);
//   без жодного запиту в мережу;
// - опис: дошка Greenhouse (`content`, один запит на компанію), акаунт Workable (`description`, один
//   запит), `blurb` компанії мережі speedrun (список компаній і одна деталь на знайдену за назвою).
// Нічого не вгадується з назви. Заповнене не переписується, null не пишеться (store.FILL_PROFILE_SQL):
// перший прогін пише кілька сотень рядків (1 рядок на компанію, індексу на цих стовпцях немає), далі
// лише нових роботодавців.
import { companyKey } from "../digest/clean.js";
import { fetchJson, type FetchOptions } from "../http.js";
import type { EngineEnv } from "../pipeline/registry.js";
import { looseKey } from "./discover.js";
import { envFlag, envInt } from "./env.js";
import { mapLimit } from "./run.js";
import { atsSourceKey, hostSlug } from "./sources/ats.js";
import { fetchSpeedrunBlurb, fetchSpeedrunCryptoCompanies } from "./sources/speedrun.js";
import type { CompanyProfileFill, CompanyProfileRow, JobsStore } from "./store.js";
import { isAtsProvider } from "./types.js";

/** Найдовший опис, символів. */
export const ABOUT_MAX = 240;
/** Коротше за це опис нічого не каже. */
export const ABOUT_MIN = 40;
/** Скільки запитів за описом за прогін найбільше (без списку компаній speedrun). */
export const ABOUT_FETCH_BUDGET = 150;

// ---------------- текст ----------------

const ENTITIES: Record<string, string> = {
  amp: "&", nbsp: " ", quot: '"', apos: "'", lt: "<", gt: ">", rsquo: "'", lsquo: "'", ldquo: '"', rdquo: '"',
  hellip: "...", mdash: "-", ndash: "-", middot: "·", bull: "·", copy: "©", reg: "®", trade: "™",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, body: string) => {
    if (body[0] === "#") {
      const code = body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : " ";
    }
    return ENTITIES[body.toLowerCase()] ?? m;
  });
}

/** Речення про вакансію, а не про компанію: такі пропускаємо. */
const JOB_SENTENCE = /^(we('re| are) (looking|hiring|seeking|searching)|we want someone|join\b|this role|the role|as an? |you will|you'll|your role|in this role|the position|this position|to achieve our mission)/i;
const JOB_WORDS = /\b(candidate|applicants?|apply now|this position|this role)\b/i;

/** Рядок-заголовок: короткий і без кінцевого розділового знака («About us», «BUILDING THE FUTURE…»). */
const isHeading = (line: string): boolean => line.length < 70 && !/[.!?]["')\]]?$/.test(line);

/**
 * Одне-два речення про компанію з HTML чи тексту дошки: без тегів і сутностей, без заголовків, без
 * речень про саму вакансію чи запитань, до `max` символів (за кінцем речення, інакше за словом з «...»),
 * без довгого тире. null, якщо лишилось коротше за ABOUT_MIN.
 */
export function aboutText(input: string | null | undefined, max = ABOUT_MAX): string | null {
  if (!input) return null;
  const text = decodeEntities(
    input.replace(/<\s*(br|\/p|\/div|\/li|\/h[1-6]|\/ul|\/ol|\/section)\b[^>]*>/gi, "\n").replace(/<[^>]*>/g, " "),
  )
    .replace(/[\u2014\u2013]/g, "-")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u00a0\t ]+/g, " ");
  const body = text.split(/\n+/).map((l) => l.trim()).filter((l) => l && !isHeading(l)).join(" ").replace(/\s+/g, " ").trim();
  const sentences = body.split(/(?<=[.!?]["')\]]?)\s+(?=["'(]?[A-Z0-9])/)
    .map((s) => s.trim())
    .filter((s) => s && !s.endsWith("?") && !JOB_SENTENCE.test(s) && !JOB_WORDS.test(s));
  if (sentences.length === 0) return null;
  let out = sentences[0]!;
  if (out.length > max) {
    const cut = out.slice(0, max - 3);
    const space = cut.lastIndexOf(" ");
    out = `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:-]+$/, "")}...`;
  } else if (sentences[1] && out.length + 1 + sentences[1].length <= max) {
    out = `${out} ${sentences[1]}`;
  }
  return out.length >= ABOUT_MIN ? out : null;
}

// ---------------- домен ----------------

/** Хости ATS, дошок, агрегаторів і загальних сервісів: це не сайт компанії. */
const NOT_COMPANY_HOSTS = [
  "greenhouse.io", "lever.co", "ashbyhq.com", "workable.com", "smartrecruiters.com", "recruitee.com", "teamtailor.com",
  "breezy.hr", "bamboohr.com", "rippling.com", "rippling-ats.com", "personio.de", "personio.com", "web3.career",
  "speedrun-talent-network.com", "getro.com", "getro.org", "notion.site", "notion.so", "jobstash.xyz", "remote3.co",
  "wellfound.com", "angel.co", "linkedin.com", "google.com", "forms.gle", "typeform.com", "myworkdayjobs.com",
  "workday.com", "gem.com", "dover.com", "dover.io", "screenloop.com", "pinpointhq.com", "jobvite.com", "icims.com",
  "applytojob.com", "jazzhr.com", "recruiterbox.com", "comeet.com", "comeet.co", "welcometothejungle.com",
  "cryptojobslist.com", "cryptocurrencyjobs.co", "superteam.fun", "github.com", "gitbook.io", "medium.com",
  "x.com", "twitter.com", "t.me", "telegram.org", "discord.com", "discord.gg", "tally.so", "airtable.com",
  "wixsite.com", "webflow.io", "framer.website", "join.com", "polymer.co", "workatastartup.com", "ycombinator.com",
];

/** Перший ярлик, що означає «сторінка кар'єри», а не окремий продукт. */
const CAREER_LABELS = new Set(["www", "careers", "career", "jobs", "job", "apply", "join", "work", "boards", "hire", "hiring", "talent"]);

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const TLD = /\.[a-z]{2,24}$/;

/**
 * Сайт компанії з адреси: хост без www і без «careers.», «jobs.» тощо, поки лишається щонайменше два
 * ярлики; null для ATS, дошок і загальних сервісів, для IP і кривих адрес.
 */
export function companyDomain(url: string | null | undefined): string | null {
  if (!url) return null;
  let host: string;
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    host = u.hostname.toLowerCase().replace(/\.$/, "");
  } catch {
    return null;
  }
  if (!DOMAIN.test(host) || !TLD.test(host)) return null;
  if (NOT_COMPANY_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return null;
  let labels = host.split(".");
  while (labels.length > 2 && CAREER_LABELS.has(labels[0]!)) labels = labels.slice(1);
  const out = labels.join(".");
  return DOMAIN.test(out) && out.length <= 253 ? out : null;
}

/** «company site https://www.3jane.xyz/ careers page …» у примітці реєстру → «3jane.xyz». */
export function domainFromNote(note: string | null | undefined): string | null {
  const m = /company site (https?:\/\/[^\s;,)]+)/i.exec(note ?? "");
  return m ? companyDomain(m[1]) : null;
}

/** Слаг Ashby, що сам є доменом («kraken.com»). Інші провайдери так не роблять. */
export function domainFromAshbySlug(provider: string, atsSlug: string): string | null {
  if (provider !== "ashby" || !atsSlug.includes(".")) return null;
  return companyDomain(`https://${atsSlug.toLowerCase()}/`);
}

/** Найчастіший власний хост серед адрес вакансій; за рівного числа перший за абеткою. */
export function domainFromJobUrls(urls: readonly string[]): string | null {
  const counts = new Map<string, number>();
  for (const u of urls) {
    const d = companyDomain(u);
    if (d) counts.set(d, (counts.get(d) ?? 0) + 1);
  }
  return [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))[0]?.[0] ?? null;
}

/** Ключ джерела вакансій компанії в jobs_cache.source (у нижньому регістрі для порівняння). */
export function profileSourceKey(row: Pick<CompanyProfileRow, "ats_provider" | "ats_slug">): string | null {
  return isAtsProvider(row.ats_provider) ? atsSourceKey(row.ats_provider, row.ats_slug).toLowerCase() : null;
}

/** Домен компанії без мережі: примітка, слаг Ashby, адреси вакансій. */
export function planDomain(row: CompanyProfileRow, urlsBySource: ReadonlyMap<string, readonly string[]>): string | null {
  const key = profileSourceKey(row);
  return domainFromNote(row.note) ?? domainFromAshbySlug(row.ats_provider, row.ats_slug)
    ?? (key ? domainFromJobUrls(urlsBySource.get(key) ?? []) : null);
}

// ---------------- опис з ATS ----------------

const GREENHOUSE_SLUG = /^[a-z0-9][a-z0-9_.-]{0,80}$/i;

/** Опис дошки Greenhouse (`content`). */
export async function fetchGreenhouseAbout(slug: string, o: FetchOptions = {}): Promise<string | null> {
  if (!GREENHOUSE_SLUG.test(slug) || slug.includes("..")) return null;
  const p = await fetchJson<{ content?: unknown }>(`https://boards-api.greenhouse.io/v1/boards/${slug}`, {}, o);
  return typeof p.content === "string" ? aboutText(p.content) : null;
}

/** Опис акаунта Workable (`description`). */
export async function fetchWorkableAbout(slug: string, o: FetchOptions = {}): Promise<string | null> {
  const s = hostSlug(slug, "workable");
  const p = await fetchJson<{ description?: unknown }>(`https://apply.workable.com/api/v1/widget/accounts/${s}`, {}, o);
  return typeof p.description === "string" ? aboutText(p.description) : null;
}

// ---------------- прогін ----------------

export interface AboutDeps {
  store: JobsStore;
  env: EngineEnv;
  log?: (line: string) => void;
  fetch?: FetchOptions;
}

export interface AboutReport {
  dry: boolean;
  /** Стовпців domain/about ще немає: нічого не зроблено. */
  skipped: string | null;
  companies: number;
  domains: { note: number; ashby: number; jobs: number };
  about: { greenhouse: number; workable: number; speedrun: number };
  /** Запитів за описом (без списку компаній speedrun) і скільки з них не відповіли. */
  fetched: number;
  failed: number;
  fills: CompanyProfileFill[];
  rowsWritten: { estimated: number; measured: number | null };
}

/**
 * Дописати компаніям відсутні домен і опис. Кожне джерело окремо: збій одного запиту чи списку speedrun
 * лише лишає поле порожнім до наступного прогону. Вимкнені компанії отримують лише домен (без запитів).
 */
export async function runCompanyAbout(deps: AboutDeps): Promise<AboutReport> {
  const { store, env } = deps;
  const log = deps.log ?? ((l: string) => console.log(l));
  const o = deps.fetch ?? {};
  const report: AboutReport = { dry: store.dry, skipped: null, companies: 0, domains: { note: 0, ashby: 0, jobs: 0 },
    about: { greenhouse: 0, workable: 0, speedrun: 0 }, fetched: 0, failed: 0, fills: [], rowsWritten: { estimated: 0, measured: null } };

  const rows = await store.loadCompanyProfiles();
  if (!rows) {
    report.skipped = "companies.domain/about missing";
    log("jobs-about: companies.domain/about missing (apply db/jobs/0005_company_profile.sql first), nothing done");
    return report;
  }
  report.companies = rows.length;
  const budget = envInt(env, "JOBS_ABOUT_BUDGET", ABOUT_FETCH_BUDGET, 0, 5000);

  // 1. Домени без мережі.
  const urlsBySource = new Map<string, string[]>();
  for (const r of await store.atsJobUrls()) {
    const k = r.source.toLowerCase();
    const list = urlsBySource.get(k);
    if (list) list.push(r.url); else urlsBySource.set(k, [r.url]);
  }
  const fills = new Map<string, CompanyProfileFill>();
  const fill = (slug: string): CompanyProfileFill => {
    let f = fills.get(slug);
    if (!f) { f = { slug, domain: null, about: null }; fills.set(slug, f); }
    return f;
  };
  for (const row of rows) {
    if (row.domain) continue;
    const fromNote = domainFromNote(row.note);
    const fromSlug = fromNote ? null : domainFromAshbySlug(row.ats_provider, row.ats_slug);
    const d = planDomain(row, urlsBySource);
    if (!d) continue;
    fill(row.slug).domain = d;
    if (fromNote) report.domains.note++; else if (fromSlug) report.domains.ashby++; else report.domains.jobs++;
  }

  // 2. Опис з ATS: лише увімкнені без опису, у межах бюджету запитів.
  let left = budget;
  const missing = rows.filter((r) => Number(r.enabled) === 1 && !r.about);
  const fromAts = missing.filter((r) => r.ats_provider === "greenhouse" || r.ats_provider === "workable").slice(0, left);
  left -= fromAts.length;
  const found = new Set<string>();
  await mapLimit(fromAts, 4, async (row) => {
    report.fetched++;
    try {
      const about = row.ats_provider === "greenhouse" ? await fetchGreenhouseAbout(row.ats_slug, o) : await fetchWorkableAbout(row.ats_slug, o);
      if (!about) return;
      fill(row.slug).about = about;
      found.add(row.slug);
      if (row.ats_provider === "greenhouse") report.about.greenhouse++; else report.about.workable++;
    } catch {
      report.failed++;
    }
  });

  // 3. Решта: blurb мережі speedrun для компаній, яких мережа знає за назвою.
  const rest = missing.filter((r) => !found.has(r.slug));
  if (rest.length && left > 0 && envFlag(env, "JOBS_SPEEDRUN", true)) {
    let network = new Map<string, string>();
    try {
      network = await fetchSpeedrunCryptoCompanies(o);
    } catch (e) {
      log(`jobs-about: speedrun company list did not answer (${e instanceof Error ? e.message.slice(0, 120) : "unknown"})`);
    }
    const byName = new Map<string, string>();
    for (const [slug, name] of network) {
      for (const k of [companyKey(name), looseKey(name)]) if (k && !byName.has(k)) byName.set(k, slug);
    }
    const matched = rest
      .map((row) => ({ row, slug: byName.get(companyKey(row.name)) ?? byName.get(looseKey(row.name)) }))
      .filter((m): m is { row: CompanyProfileRow; slug: string } => !!m.slug)
      .slice(0, left);
    await mapLimit(matched, 2, async ({ row, slug }) => {
      report.fetched++;
      try {
        const about = aboutText(await fetchSpeedrunBlurb(slug, o));
        if (!about) return;
        fill(row.slug).about = about;
        report.about.speedrun++;
      } catch {
        report.failed++;
      }
    });
  }

  report.fills = [...fills.values()].sort((a, b) => (a.slug < b.slug ? -1 : 1));
  await store.fillCompanyProfiles(report.fills);
  report.rowsWritten = { estimated: store.estimatedRows, measured: store.dry ? null : store.measuredRows };
  const d = report.domains;
  const a = report.about;
  log(`jobs-about${store.dry ? " --dry" : ""}: ${rows.length} companies; domains +${d.note + d.ashby + d.jobs} ` +
    `(note ${d.note}, ashby slug ${d.ashby}, job links ${d.jobs}); about +${a.greenhouse + a.workable + a.speedrun} ` +
    `(greenhouse ${a.greenhouse}, workable ${a.workable}, speedrun ${a.speedrun}); ${report.fetched} requests, ${report.failed} failed; ` +
    `D1 rows ${store.dry ? `would be ${store.estimatedRows}` : `written ${store.measuredRows ?? "unknown"}`}`);
  return report;
}
