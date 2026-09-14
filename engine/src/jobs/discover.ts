// Щотижнева розвідка роботодавців (`jobs-discover [--dry]`): нові крипто-компанії з публічним ATS
// у реєстр (таблиця companies). Вакансій не пише; їх далі читає щоденний скан з API самого ATS.
//
// Джерела посилань:
// - speedrun (типово ввімкнено): крипто-компанії мережі й адреса подачі їхньої ролі, тобто точне
//   знання, де ATS роботодавця. API відкритий і задокументований.
// - колекції Getro (типово ВИМКНЕНО, JOBS_GETRO_DISCOVERY=1): умови Getro забороняють crawl і scrape
//   будь-якої частини сервісу (sources/getro.ts). Ідея перенесена з NextRole (crypto-jobs-agent,
//   scanner: discover-getro-ats.ts): з колекції лише посилання на ATS, вакансій з Getro в базі немає.
import { randomUUID } from "node:crypto";
import { companyKey, isNonCryptoCompany } from "../digest/clean.js";
import type { FetchOptions } from "../http.js";
import type { EngineEnv } from "../pipeline/registry.js";
import { envFlag } from "./env.js";
import { atsSourceKey, hostSlug } from "./sources/ats.js";
import { extractAts, fetchGetroLinks, type GetroLink } from "./sources/getro.js";
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

export interface DiscoverReport {
  dry: boolean;
  speedrun: { companies: number; withAts: number } | null;
  getro: Array<{ id: number; links: number; crypto: number; withAts: number }> | null;
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

/**
 * Кандидати в реєстр з посилань: лише публічний ATS, не з не-крипто списку, дошки ще немає.
 * slug компанії = слаг ATS, а якщо його вже зайнято іншою дошкою, слаг-провайдер.
 */
export function newCompanies(
  links: ReadonlyArray<{ url: string; company: string; via: string }>,
  knownBoards: ReadonlySet<string>, knownSlugs: ReadonlySet<string>,
): NewCompany[] {
  const out: NewCompany[] = [];
  const boards = new Set(knownBoards);
  const slugs = new Set(knownSlugs);
  for (const l of links) {
    const name = l.company.replace(/\s+/g, " ").trim();
    if (!name || isNonCryptoCompany(companyKey(name), name)) continue;
    const hit = extractAts(l.url);
    if (!hit) continue;
    const atsSlug = usableSlug(hit.provider, hit.slug);
    if (!atsSlug) continue;
    const board = `${hit.provider}:${atsSlug.toLowerCase()}`;
    if (boards.has(board)) continue;
    const base = atsSlug.toLowerCase().replace(/%20/g, "-").replace(/[^a-z0-9._-]/g, "-");
    const slug = slugs.has(base) ? `${base}-${hit.provider}` : base;
    if (slugs.has(slug)) continue;
    boards.add(board);
    slugs.add(slug);
    out.push({ slug, name: name.slice(0, 120), provider: hit.provider, atsSlug, discoveredVia: l.via, note: `found via ${l.via}: ${atsSourceKey(hit.provider, atsSlug)}` });
  }
  return out;
}

/** Getro: лише організації, про які Getro каже «крипто»; без жодної галузі бере крипто-колекцію як запас. */
export const cryptoLinks = (links: readonly GetroLink[]): GetroLink[] => links.filter((l) => l.industry !== "other");

export async function runJobsDiscover(deps: DiscoverDeps): Promise<DiscoverReport> {
  const { store, env } = deps;
  const now = deps.now ?? new Date();
  const log = deps.log ?? ((l: string) => console.log(l));
  const o = deps.fetch ?? {};
  const runId = `discover_${randomUUID()}`;
  await store.startRun(runId, "discover", now.toISOString());
  const links: Array<{ url: string; company: string; via: string }> = [];
  const report: DiscoverReport = { dry: store.dry, speedrun: null, getro: null, added: [], rowsWritten: { estimated: 0, measured: null } };
  try {
    if (envFlag(env, "JOBS_SPEEDRUN", true)) {
      const companies = await fetchSpeedrunCryptoCompanies(o);
      let withAts = 0;
      for (const [slug, name] of companies) {
        try {
          const id = await firstJobId(slug, o);
          const apply = id ? await fetchApplyUrl(id, o) : null;
          if (apply && extractAts(apply)) { withAts++; links.push({ url: apply, company: name, via: "speedrun" }); }
        } catch { /* одна компанія не відповіла: решта від цього не залежить */ }
      }
      report.speedrun = { companies: companies.size, withAts };
      log(`jobs-discover: speedrun ${companies.size} crypto companies, ${withAts} with a public ATS`);
    }

    if (envFlag(env, "JOBS_GETRO_DISCOVERY", false)) {
      const { getro } = await store.loadRegistry();
      report.getro = [];
      // По одній колекції й з паузою між сторінками: тиждень чекати нікуди не спішить.
      for (const c of getro) {
        try {
          const all = await fetchGetroLinks(c.id, { ...o, retries: 3, retryDelayMs: 2_000 });
          const crypto = cryptoLinks(all);
          const withAts = crypto.filter((l) => extractAts(l.url) !== null);
          for (const l of withAts) links.push({ url: l.url, company: l.company, via: `getro:${c.id}` });
          report.getro.push({ id: c.id, links: all.length, crypto: crypto.length, withAts: withAts.length });
          log(`  getro:${c.id} ${c.label}: ${all.length} jobs, ${crypto.length} at crypto orgs, ${withAts.length} with a public ATS`);
        } catch (e) {
          log(`  getro:${c.id} ${c.label}: no answer (${e instanceof Error ? e.message : String(e)})`);
        }
      }
    } else {
      log("jobs-discover: Getro collections are not read (JOBS_GETRO_DISCOVERY is off; see engine/deploy/README.md)");
    }

    const added = newCompanies(links, await store.knownBoards(), await store.knownSlugs());
    await store.addCompanies(added);
    report.added = added;
    report.rowsWritten = { estimated: store.estimatedRows, measured: store.dry ? null : store.measuredRows };
    await store.finishRun(runId, { status: "ok", sourcesOk: 0, sourcesFailed: 0, jobsFound: 0, jobsNew: added.length,
      rowsWritten: store.dry ? null : store.measuredRows, notes: { speedrun: report.speedrun, getro: report.getro,
        added: added.map((c) => `${c.provider}:${c.atsSlug} ${c.name}`) } }, new Date().toISOString());
    log(`jobs-discover${store.dry ? " --dry" : ""}: ${added.length} new companies${added.length ? `: ${added.map((c) => `${c.name} (${c.provider}:${c.atsSlug})`).join(", ")}` : ""}` +
        `; D1 rows ${store.dry ? `would be ${store.estimatedRows}` : `written ${store.measuredRows ?? "unknown"}`}`);
    return report;
  } catch (e) {
    await store.finishRun(runId, { status: "failed", sourcesOk: 0, sourcesFailed: 0, jobsFound: 0, jobsNew: 0, rowsWritten: null,
      notes: { error: (e instanceof Error ? e.message : String(e)).slice(0, 500) } }, new Date().toISOString()).catch(() => undefined);
    throw e;
  }
}
