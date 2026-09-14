// Щотижнева розвідка роботодавців (`jobs-discover [--dry] [--out <file>]`): нові крипто-компанії з
// публічним ATS у реєстр (таблиця companies). Вакансій не пише; їх далі читає щоденний скан з API самого ATS.
//
// Джерела посилань:
// - speedrun (типово ввімкнено): крипто-компанії мережі й адреса подачі їхньої ролі, тобто точне
//   знання, де ATS роботодавця. API відкритий і задокументований.
// - дошки екосистем і фондів на Getro (реєстр job_boards, рішення 'discover'; вмикає
//   JOBS_GETRO_DISCOVERY=1): умови Getro забороняють crawl і scrape (sources/getro.ts), власник 14.09
//   прийняв ризик малого обсягу. Кожна дошка раз на тиждень: список її компаній (по 12 на сторінку, з
//   паузою), і лише для компанії з вакансіями, якої реєстр ще не знає, одна сторінка її вакансій, з якої
//   береться тільки адреса, куди вони ведуть. Адреса на ATS = готова дошка; адреса на сайт роботодавця =
//   одна-дві його сторінки (sources/careers.ts) у пошуках ATS. Нова дошка ATS спершу має відповісти
//   своїм API, і лише тоді йде в реєстр. Компанії, чиї вакансії живуть лише на Getro, у реєстр не
//   йдуть: вони в звіті окремим списком, їх ніхто не читає.
import { randomUUID } from "node:crypto";
import { companyKey, isNonCryptoCompany } from "../digest/clean.js";
import type { FetchOptions } from "../http.js";
import type { EngineEnv } from "../pipeline/registry.js";
import { envFlag, envInt } from "./env.js";
import type { CryptoScope, GetroBoard } from "./job-boards.js";
import { mapLimit } from "./run.js";
import { ATS, atsSourceKey, hostSlug } from "./sources/ats.js";
import { atsHintFromUrl, resolveCareerPage } from "./sources/careers.js";
import { classifyLink, extractAts, fetchGetroCompanies, fetchGetroOrgLinks, type GetroLink, type OrgIndustry } from "./sources/getro.js";
import { fetchApplyUrl, fetchSpeedrunCryptoCompanies, firstJobId } from "./sources/speedrun.js";
import type { JobsStore, NewCompany } from "./store.js";
import type { AtsProvider } from "./types.js";

export interface DiscoverDeps {
  store: JobsStore;
  env: EngineEnv;
  now?: Date;
  log?: (line: string) => void;
  fetch?: FetchOptions;
}

/** Підсумок однієї дошки Getro. Компанія на кількох дошках рахується в кожній; «нові» можуть збігатися. */
export interface BoardDiscovery {
  board: string;
  id: number;
  label: string;
  /** Компаній у списку дошки. */
  companies: number;
  /** З них з відкритими вакансіями. */
  withJobs: number;
  /** З вакансіями й крипто (crypto_scope дошки і список не-крипто компаній добірки). */
  cryptoOrgs: number;
  /** Реєстр уже знає за назвою: вакансій дошки для неї не читали. */
  known: number;
  /** Дошку ATS видно прямо з посилання вакансії. */
  ats: number;
  /** Дошку ATS знайдено на сторінці кар'єри роботодавця. */
  viaCareerPage: number;
  /** Вакансії лише на самій дошці Getro: своєї сторінки чи ATS немає. */
  hostedOnly: number;
  /** ATS, який скан не читає (Workday, Gem, Dover, Notion…). */
  otherAts: number;
  /** Сторінка роботодавця без адреси ATS (або не відповіла). */
  unresolved: number;
  /** Дошка ATS уже в реєстрі (компанія під іншою назвою). */
  knownBoard: number;
  /** Нова дошка ATS, що відповіла своїм API (у реєстр). */
  added: number;
  /** Запитів до Getro за цю дошку (список компаній + вакансії невідомих). */
  requests: number;
  error?: string;
}

export interface OrgNote { company: string; boards: string[]; jobs: number; detail?: string }

export interface DiscoverReport {
  dry: boolean;
  speedrun: { companies: number; withAts: number } | null;
  getro: BoardDiscovery[] | null;
  /** Компанії лише на Getro (без власного ATS чи сторінки): не читаються. */
  hostedOnly: OrgNote[];
  /** Компанії на ATS, якого скан не читає. */
  otherAts: OrgNote[];
  /** Сторінка кар'єри без адреси ATS. */
  unresolved: OrgNote[];
  /** Нова дошка ATS не відповіла своїм API: у реєстр не пішла. */
  unverified: OrgNote[];
  /** Та сама компанія вже є в реєстрі під іншою дошкою (увімкненою): не додаємо вдруге. */
  knownByName: OrgNote[];
  added: NewCompany[];
  rowsWritten: { estimated: number; measured: number | null };
}

const HOST_SLUG_PROVIDERS: readonly AtsProvider[] = ["workable", "smartrecruiters", "recruitee", "breezy", "bamboohr", "rippling", "personio"];

/** Слаг ATS, який скан зможе прочитати; null, якщо форма підозріла. */
function usableSlug(provider: AtsProvider, slug: string): string | null {
  try {
    if (HOST_SLUG_PROVIDERS.includes(provider)) return hostSlug(slug, provider);
    if (provider === "teamtailor") return slug.split(".").every((l) => /^[a-z0-9][a-z0-9-]{0,62}$/i.test(l)) ? slug.toLowerCase() : null;
    return /^[a-z0-9][a-z0-9_.%-]{0,80}$/i.test(slug) && !slug.includes("..") ? slug : null;
  } catch {
    return null;
  }
}

/** Загальні слова назви: «Ethena Labs» і «Ethena» одна компанія. */
const GENERIC_NAME_WORDS = new Set(["labs", "lab", "foundation", "protocol", "network", "networks", "technologies", "technology",
  "finance", "dao", "xyz", "io", "hq", "app", "group", "the", "fi", "studios", "studio", "official"]);

/** companyKey без загальних слів; якщо лишилось порожньо, сам companyKey. */
export function looseKey(name: string): string {
  const words = companyKey(name).split(" ").filter(Boolean);
  const core = words.filter((w) => !GENERIC_NAME_WORDS.has(w));
  return (core.length ? core : words).join(" ");
}

/**
 * Чи знає реєстр компанію за назвою: точний companyKey, або «Ethena Labs» проти «Ethena» (одна з назв
 * без загальних слів). «Solana Foundation» і «Solana Labs» різні: у жодної назва не збігається з голою
 * «solana». true: є увімкнений рядок; false: лише вимкнені; undefined: не знає.
 */
export function nameLookup(known: ReadonlyMap<string, boolean>): (name: string) => boolean | undefined {
  const loose = new Map<string, boolean>();
  for (const [k, on] of known) {
    const l = looseKey(k);
    loose.set(l, (loose.get(l) ?? false) || on);
  }
  return (name: string) => {
    const k = companyKey(name);
    return known.get(k) ?? known.get(looseKey(name)) ?? loose.get(k);
  };
}

/**
 * Дошки самих постачальників інструментів: сторінка «кар'єра» компанії на Notion веде в ashby:notion
 * самого Notion, а не компанії. Лише ці слаги; решта не-крипто компаній відсіюється за назвою.
 */
const VENDOR_BOARDS = new Set(["notion", "ashby", "greenhouse", "lever", "workable", "rippling", "teamtailor", "gem", "dover"]);

/** Кандидат у реєстр: дошка ATS, назва компанії, звідки відомо. */
export interface Candidate { provider: AtsProvider; slug: string; company: string; via: string; note?: string }

export interface CandidateSkip { company: string; board: string; why: "known-name" }

/**
 * Кандидати в реєстр: лише публічний ATS, не з не-крипто списку, не дошка постачальника інструментів,
 * дошки ще немає, і тієї самої компанії з увімкненою дошкою теж немає. slug компанії = слаг ATS, а
 * якщо його вже зайнято іншою дошкою, слаг-провайдер.
 */
export function newCompaniesFrom(
  cands: readonly Candidate[], knownBoards: ReadonlySet<string>, knownSlugs: ReadonlySet<string>,
  knownNames: ReadonlyMap<string, boolean> = new Map(),
): { added: NewCompany[]; skipped: CandidateSkip[] } {
  const added: NewCompany[] = [];
  const skipped: CandidateSkip[] = [];
  const boards = new Set(knownBoards);
  const slugs = new Set(knownSlugs);
  const names = new Set<string>();
  const lookup = nameLookup(knownNames);
  for (const c of cands) {
    const name = c.company.replace(/\s+/g, " ").trim();
    const key = companyKey(name);
    if (!name || isNonCryptoCompany(key, name)) continue;
    const atsSlug = usableSlug(c.provider, c.slug);
    if (!atsSlug || VENDOR_BOARDS.has(atsSlug.toLowerCase())) continue;
    const board = `${c.provider}:${atsSlug.toLowerCase()}`;
    if (boards.has(board)) continue;
    const known = lookup(name);
    if (known === true) { skipped.push({ company: name, board, why: "known-name" }); continue; }
    if (names.has(key)) continue;
    const base = atsSlug.toLowerCase().replace(/%20/g, "-").replace(/[^a-z0-9._-]/g, "-");
    const slug = slugs.has(base) ? `${base}-${c.provider}` : base;
    if (slugs.has(slug)) continue;
    boards.add(board);
    slugs.add(slug);
    names.add(key);
    const replaces = known === false ? "; the same company is in the registry only with a disabled board" : "";
    added.push({ slug, name: name.slice(0, 120), provider: c.provider, atsSlug, discoveredVia: c.via,
      note: `${c.note ?? `found via ${c.via}: ${atsSourceKey(c.provider, atsSlug)}`}${replaces}` });
  }
  return { added, skipped };
}

/** Посилання → кандидати (ATS прямо з адреси). Для speedrun і тестів. */
export function newCompanies(
  links: ReadonlyArray<{ url: string; company: string; via: string }>,
  knownBoards: ReadonlySet<string>, knownSlugs: ReadonlySet<string>, knownNames?: ReadonlyMap<string, boolean>,
): NewCompany[] {
  const cands: Candidate[] = [];
  for (const l of links) {
    const hit = extractAts(l.url);
    if (hit) cands.push({ provider: hit.provider, slug: hit.slug, company: l.company, via: l.via });
  }
  return newCompaniesFrom(cands, knownBoards, knownSlugs, knownNames).added;
}

/** Getro: лише організації, про які Getro каже «крипто»; без жодної галузі бере крипто-колекцію як запас. */
export const cryptoLinks = (links: readonly GetroLink[]): GetroLink[] => links.filter((l) => l.industry !== "other");

/** Одна організація дошки: що кажуть посилання її вакансій. */
export interface OrgLinks {
  company: string;
  jobs: number;
  hosted: number;
  industry: OrgIndustry;
  ats: Map<string, { provider: AtsProvider; slug: string; n: number }>;
  otherAts: Map<string, number>;
  careerUrls: string[];
}

/** Посилання дошки → організації (за id Getro, інакше за назвою). */
export function groupOrgs(links: readonly GetroLink[]): OrgLinks[] {
  const byKey = new Map<string, OrgLinks>();
  for (const l of links) {
    const name = l.company.replace(/\s+/g, " ").trim();
    if (!name) continue;
    const key = l.orgId ? `id:${l.orgId}` : `name:${companyKey(name)}`;
    let o = byKey.get(key);
    if (!o) { o = { company: name, jobs: 0, hosted: 0, industry: l.industry, ats: new Map(), otherAts: new Map(), careerUrls: [] }; byKey.set(key, o); }
    o.jobs++;
    if (l.industry === "crypto") o.industry = "crypto";
    const k = classifyLink(l);
    if (k.kind === "hosted") o.hosted++;
    else if (k.kind === "ats") {
      const b = `${k.provider}:${k.slug.toLowerCase()}`;
      const cur = o.ats.get(b);
      if (cur) cur.n++; else o.ats.set(b, { provider: k.provider, slug: k.slug, n: 1 });
    } else if (k.kind === "other-ats") o.otherAts.set(k.name, (o.otherAts.get(k.name) ?? 0) + 1);
    else if (o.careerUrls.length < 3 && !o.careerUrls.includes(l.url)) o.careerUrls.push(l.url);
  }
  return [...byKey.values()];
}

/** Найчастіша дошка ATS організації. */
export function bestAts(o: OrgLinks): { provider: AtsProvider; slug: string } | null {
  const best = [...o.ats.values()].sort((a, b) => b.n - a.n)[0];
  return best ? { provider: best.provider, slug: best.slug } : null;
}

/**
 * Чи бере розвідка організацію як крипто: список не-крипто компаній завжди; далі за crypto_scope
 * дошки: 'all' кожну, 'tagged' ту, кого Getro називає крипто або ніяк, 'strict' лише названу крипто.
 */
export function inScope(o: { company: string; industry: OrgIndustry }, scope: CryptoScope): boolean {
  if (isNonCryptoCompany(companyKey(o.company), o.company)) return false;
  if (scope === "all") return true;
  if (scope === "strict") return o.industry === "crypto";
  return o.industry !== "other";
}

type Resolution =
  | { kind: "ats"; provider: AtsProvider; slug: string; from: "link" | "career-page"; page?: string }
  | { kind: "hosted" } | { kind: "other-ats"; name: string } | { kind: "unresolved"; detail?: string };

/** Скільки сторінок кар'єри читати за прогін найбільше (по одній-дві на компанію). */
const CAREER_PAGE_BUDGET = 200;

interface GetroResult {
  cands: Candidate[];
  stats: BoardDiscovery[];
  hostedOnly: OrgNote[];
  otherAts: OrgNote[];
  unresolved: OrgNote[];
  /** Для лічильників дошок після перевірки: компанія → її дошка ATS і дошки Getro. */
  perBoardKeys: Map<string, string[]>;
  resolved: Map<string, Resolution>;
}

/**
 * Дошки Getro: список компаній кожної, далі сторінка вакансій лише невідомої реєстру компанії з
 * вакансіями, далі розв'язання адрес. Одна компанія на кількох дошках читається один раз.
 */
async function discoverGetro(boards: readonly GetroBoard[], known: (name: string) => boolean | undefined, env: EngineEnv,
                             o: FetchOptions): Promise<GetroResult> {
  const maxPages = envInt(env, "JOBS_GETRO_MAX_PAGES", 50, 1, 200);
  const go: FetchOptions = { ...o, retries: 3, retryDelayMs: 2_000 };
  const global = new Map<string, { org: OrgLinks; boards: string[] }>();
  const stats: BoardDiscovery[] = [];
  const perBoardKeys = new Map<string, string[]>();
  // Дошки по одній, запити по одному з паузою (бюджет api.getro.com у limits.ts): тиждень чекати нікуди не спішить.
  for (const b of boards) {
    const s: BoardDiscovery = { board: b.slug, id: b.collectionId, label: b.label, companies: 0, withJobs: 0, cryptoOrgs: 0, known: 0,
      ats: 0, viaCareerPage: 0, hostedOnly: 0, otherAts: 0, unresolved: 0, knownBoard: 0, added: 0, requests: 0 };
    stats.push(s);
    const keys: string[] = [];
    perBoardKeys.set(b.slug, keys);
    try {
      const companies = await fetchGetroCompanies(b.collectionId, go, maxPages);
      s.requests += Math.max(1, Math.ceil(companies.length / 12));
      s.companies = companies.length;
      for (const c of companies) {
        if (c.activeJobs <= 0) continue;
        s.withJobs++;
        if (!inScope({ company: c.name, industry: c.industry }, b.cryptoScope)) continue;
        s.cryptoOrgs++;
        if (known(c.name) === true) { s.known++; continue; }
        const key = companyKey(c.name);
        keys.push(key);
        const g = global.get(key);
        if (g) { if (!g.boards.includes(b.slug)) g.boards.push(b.slug); continue; }
        try {
          s.requests++;
          const links = await fetchGetroOrgLinks(b.collectionId, c.id, go, b.host);
          const org = groupOrgs(links.map((l) => ({ ...l, company: c.name, orgId: c.id })))[0]
            ?? { company: c.name, jobs: 0, hosted: 0, industry: c.industry, ats: new Map(), otherAts: new Map(), careerUrls: [] };
          global.set(key, { org, boards: [b.slug] });
        } catch { /* одна компанія не відповіла: наступного тижня ще раз */ }
      }
    } catch (e) {
      s.error = (e instanceof Error ? e.message : String(e)).slice(0, 200);
    }
  }

  const resolved = new Map<string, Resolution>();
  const toCareer: Array<[string, OrgLinks]> = [];
  for (const [key, g] of global) {
    const hit = bestAts(g.org);
    if (hit) { resolved.set(key, { kind: "ats", ...hit, from: "link" }); continue; }
    if (g.org.careerUrls.length) { toCareer.push([key, g.org]); continue; }
    const other = [...g.org.otherAts.entries()].sort((a, b) => b[1] - a[1])[0];
    resolved.set(key, other ? { kind: "other-ats", name: other[0] } : g.org.hosted ? { kind: "hosted" } : { kind: "unresolved", detail: "no jobs listed" });
  }
  await mapLimit(toCareer.slice(0, CAREER_PAGE_BUDGET), 4, async ([key, org]) => {
    const url = org.careerUrls[0]!;
    const found = await resolveCareerPage(url, o);
    if (found) { resolved.set(key, { kind: "ats", ...found.hit, from: "career-page", page: found.from }); return; }
    const other = [...org.otherAts.entries()].sort((a, b) => b[1] - a[1])[0];
    const hint = org.careerUrls.map(atsHintFromUrl).find(Boolean);
    let host = url;
    try { host = new URL(url).hostname; } catch { /* лишаємо адресу */ }
    resolved.set(key, other ? { kind: "other-ats", name: other[0] } : { kind: "unresolved", detail: hint ? `${host} (${hint}, slug not on the page)` : host });
  });
  for (const [key] of toCareer.slice(CAREER_PAGE_BUDGET)) resolved.set(key, { kind: "unresolved", detail: "careers page budget spent" });

  const cands: Candidate[] = [];
  for (const [key, g] of global) {
    const r = resolved.get(key);
    if (r?.kind !== "ats") continue;
    const b = boards.find((x) => x.slug === g.boards[0])!;
    const via = `getro:${b.collectionId}`;
    const board = atsSourceKey(r.provider, r.slug);
    const also = g.boards.length > 1 ? `also ${g.boards.slice(1).join(", ")}` : "only there";
    cands.push({ provider: r.provider, slug: r.slug, company: g.org.company, via,
      note: r.from === "link"
        ? `found via ${via} (${b.label} board, ${also}): its jobs link ${board}`
        : `found via ${via} (${b.label} board, ${also}): the company careers page ${r.page} links ${board}` });
  }
  const noteList = (kind: Resolution["kind"], detail: (r: Resolution) => string | undefined): OrgNote[] =>
    [...global].filter(([k]) => resolved.get(k)?.kind === kind)
      .map(([k, g]) => {
        const d = detail(resolved.get(k)!);
        return { company: g.org.company, boards: g.boards, jobs: g.org.jobs, ...(d ? { detail: d } : {}) };
      })
      .sort((a, b) => b.jobs - a.jobs || a.company.localeCompare(b.company));
  return {
    cands, stats, perBoardKeys, resolved,
    hostedOnly: noteList("hosted", () => undefined),
    otherAts: noteList("other-ats", (r) => (r.kind === "other-ats" ? r.name : undefined)),
    unresolved: noteList("unresolved", (r) => (r.kind === "unresolved" ? r.detail : undefined)),
  };
}

export async function runJobsDiscover(deps: DiscoverDeps): Promise<DiscoverReport> {
  const { store, env } = deps;
  const now = deps.now ?? new Date();
  const log = deps.log ?? ((l: string) => console.log(l));
  const o = deps.fetch ?? {};
  const runId = `discover_${randomUUID()}`;
  await store.startRun(runId, "discover", now.toISOString());
  const cands: Candidate[] = [];
  const report: DiscoverReport = { dry: store.dry, speedrun: null, getro: null, hostedOnly: [], otherAts: [], unresolved: [],
    unverified: [], knownByName: [], added: [], rowsWritten: { estimated: 0, measured: null } };
  try {
    const knownBoards = await store.knownBoards();
    const knownSlugs = await store.knownSlugs();
    const knownNames = await store.knownNames();

    if (envFlag(env, "JOBS_SPEEDRUN", true)) {
      const companies = await fetchSpeedrunCryptoCompanies(o);
      let withAts = 0;
      for (const [slug, name] of companies) {
        try {
          const id = await firstJobId(slug, o);
          const apply = id ? await fetchApplyUrl(id, o) : null;
          const hit = apply ? extractAts(apply) : null;
          if (hit) { withAts++; cands.push({ ...hit, company: name, via: "speedrun" }); }
        } catch { /* одна компанія не відповіла: решта від цього не залежить */ }
      }
      report.speedrun = { companies: companies.size, withAts };
      log(`jobs-discover: speedrun ${companies.size} crypto companies, ${withAts} with a public ATS`);
    }

    if (envFlag(env, "JOBS_GETRO_DISCOVERY", false)) {
      const boards = await store.loadGetroBoards();
      log(`jobs-discover: ${boards.length} Getro boards (job_boards): company list of each, jobs page only for companies the registry does not know`);
      const g = await discoverGetro(boards, nameLookup(knownNames), env, o);

      // Перевірка: нова дошка ATS мусить відповісти своїм API, інакше в реєстр не йде.
      const { added: fresh, skipped } = newCompaniesFrom(g.cands, knownBoards, knownSlugs, knownNames);
      report.knownByName = skipped.map((x) => ({ company: x.company, boards: [], jobs: 0, detail: x.board }));
      const open = new Map<string, number>();
      await mapLimit(fresh, 4, async (c) => {
        try {
          open.set(`${c.provider}:${c.atsSlug.toLowerCase()}`, (await ATS[c.provider](c.atsSlug, c.name, { ...o, retries: 1 })).length);
        } catch (e) {
          report.unverified.push({ company: c.name, boards: [c.discoveredVia], jobs: 0,
            detail: `${atsSourceKey(c.provider, c.atsSlug)}: ${(e instanceof Error ? e.message : String(e)).slice(0, 120)}` });
        }
      });
      const day = now.toISOString().slice(0, 10);
      for (const c of g.cands) {
        const k = `${c.provider}:${(usableSlug(c.provider, c.slug) ?? c.slug).toLowerCase()}`;
        if (open.has(k)) cands.push({ ...c, note: `${c.note} (${open.get(k)} open on ${day})` });
      }

      for (const s of g.stats) {
        for (const key of g.perBoardKeys.get(s.board) ?? []) {
          const r = g.resolved.get(key);
          if (r?.kind === "ats") {
            if (r.from === "link") s.ats++; else s.viaCareerPage++;
            const bk = `${r.provider}:${(usableSlug(r.provider, r.slug) ?? r.slug).toLowerCase()}`;
            if (open.has(bk)) s.added++;
            else if (knownBoards.has(bk)) s.knownBoard++;
          } else if (r?.kind === "hosted") s.hostedOnly++;
          else if (r?.kind === "other-ats") s.otherAts++;
          else s.unresolved++;
        }
        log(`  getro:${s.id} ${s.label}: ${s.error ? `no answer (${s.error})` : `${s.companies} companies, ${s.withJobs} with jobs, ${s.cryptoOrgs} crypto; ` +
          `known ${s.known}; ATS ${s.ats} + ${s.viaCareerPage} via careers page (board already known ${s.knownBoard}, new ${s.added}); ` +
          `Getro-only ${s.hostedOnly}, other ATS ${s.otherAts}, unresolved ${s.unresolved}; ${s.requests} requests`}`);
      }
      report.getro = g.stats;
      report.hostedOnly = g.hostedOnly;
      report.otherAts = g.otherAts;
      report.unresolved = g.unresolved;
      const reqs = g.stats.reduce((n, s) => n + s.requests, 0);
      log(`  Getro requests this run: ${reqs}`);
      if (g.hostedOnly.length) log(`  jobs only on Getro (not read): ${g.hostedOnly.slice(0, 40).map((x) => `${x.company} ${x.jobs}`).join(", ")}`);
      if (g.otherAts.length) log(`  on an ATS the scan does not read: ${g.otherAts.slice(0, 40).map((x) => `${x.company} (${x.detail})`).join(", ")}`);
      if (g.unresolved.length) log(`  careers page without an ATS link: ${g.unresolved.slice(0, 40).map((x) => x.company).join(", ")}`);
      if (report.unverified.length) log(`  new ATS board did not answer (not added): ${report.unverified.map((x) => `${x.company} ${x.detail}`).join(" | ")}`);
    } else {
      log("jobs-discover: Getro boards are not read (JOBS_GETRO_DISCOVERY is off; see engine/deploy/README.md)");
    }

    const added = newCompaniesFrom(cands, knownBoards, knownSlugs, knownNames).added;
    await store.addCompanies(added);
    report.added = added;
    report.rowsWritten = { estimated: store.estimatedRows, measured: store.dry ? null : store.measuredRows };
    await store.finishRun(runId, { status: "ok", sourcesOk: 0, sourcesFailed: 0, jobsFound: 0, jobsNew: added.length,
      rowsWritten: store.dry ? null : store.measuredRows, notes: { speedrun: report.speedrun, getro: report.getro,
        added: added.map((c) => `${c.provider}:${c.atsSlug} ${c.name}`),
        getro_only: report.hostedOnly.slice(0, 100).map((x) => x.company) } }, new Date().toISOString());
    log(`jobs-discover${store.dry ? " --dry" : ""}: ${added.length} new companies${added.length ? `: ${added.map((c) => `${c.name} (${c.provider}:${c.atsSlug})`).join(", ")}` : ""}` +
        `; D1 rows ${store.dry ? `would be ${store.estimatedRows}` : `written ${store.measuredRows ?? "unknown"}`}`);
    return report;
  } catch (e) {
    await store.finishRun(runId, { status: "failed", sourcesOk: 0, sourcesFailed: 0, jobsFound: 0, jobsNew: 0, rowsWritten: null,
      notes: { error: (e instanceof Error ? e.message : String(e)).slice(0, 500) } }, new Date().toISOString()).catch(() => undefined);
    throw e;
  }
}
