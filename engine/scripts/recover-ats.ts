/**
 * Разовий інструмент: назви компаній → їхня власна дошка ATS.
 *
 * Привід: 17.09.2026 закрито джерело board:jobstash (на прохання власника дошки), і з бази пішли
 * вакансії 160 компаній, яких реєстр не знав. Самі вакансії нікуди не поділись: вони лежать на
 * публічних API ATS цих роботодавців, які ми й так читаємо. Інструмент шукає ці дошки за назвою:
 *
 *   1) слаг зі самої назви (57% реєстру має саме такий) і жива відповідь API кожного ATS;
 *   2) якщо не вийшло, здогад про домен (<слаг>.com/.io/.xyz…) і пошук ATS на сторінці кар'єри
 *      (sources/careers.ts resolveCompanySite), тобто той самий шлях, що в щотижневій розвідці.
 *
 * У базу нічого не пише: друкує звіт і, з --sql, готовий INSERT для db/jobs.
 *
 *   npx tsx scripts/recover-ats.ts <companies.json> [--out <file>] [--sql <file>] [--limit N]
 *
 * Вхід: [{ "company": "DRW", "n": 28 }, …] (n лише для звіту).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { companyKey, isNonCryptoCompany } from "../src/digest/clean.js";
import { mapLimit } from "../src/jobs/run.js";
import { ATS, atsSourceKey } from "../src/jobs/sources/ats.js";
import { resolveCompanySite } from "../src/jobs/sources/careers.js";
import type { AtsProvider } from "../src/jobs/types.js";

/** Провайдери за частотою в реєстрі: перший збіг виграє, тож дешевші й типовіші стоять раніше. */
const PROBE: AtsProvider[] = ["ashby", "greenhouse", "lever", "workable", "rippling", "bamboohr", "breezy", "smartrecruiters", "recruitee", "teamtailor", "personio", "lever_eu"];

/** Хвости юридичної форми: у слагу ATS їх майже ніколи немає. */
const LEGAL = /\s*\b(inc|inc\.|llc|ltd|ltd\.|limited|pte|pte\.|plc|corp|corp\.|corporation|co|a\/s|as|sa|s\.a\.|ag|gmbh|bv|b\.v\.|oy|ab|lp|l\.p\.|llp|holdings?|group)\b\.?/gi;

/** Слаги-кандидати з назви: «Nium Pte. Ltd.» → nium; «The Open Platform» → theopenplatform, openplatform. */
export function slugCandidates(name: string): string[] {
  const base = name.replace(/[,()]/g, " ").replace(LEGAL, " ").replace(/\s+/g, " ").trim();
  const plain = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  const hyphen = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const noThe = base.replace(/^the\s+/i, "");
  const out = [plain(base), plain(noThe), hyphen(base), hyphen(noThe)];
  // «Galaxy Digital», «0G Foundation»: спробувати й без останнього слова-прикладки.
  const words = noThe.split(" ");
  if (words.length > 1 && /^(digital|foundation|labs?|finance|network|protocol|technologies|tech|capital|markets?|global)$/i.test(words.at(-1)!)) {
    out.push(plain(words.slice(0, -1).join(" ")), hyphen(words.slice(0, -1).join(" ")));
  }
  return [...new Set(out.filter((s) => s.length >= 3))];
}

/** Домени-кандидати, коли слаг ATS не вгадався. */
/**
 * Другий захід для однослівних назв: дошка часто заведена на повну назву компанії, а не на бренд
 * («Ondo» → `ondofinance`). Ці варіанти пробуємо лише на трьох найчастіших ATS, щоб не робити
 * десятки марних запитів на кожну назву.
 */
export function extraSlugCandidates(name: string): string[] {
  const first = slugCandidates(name)[0];
  if (!first || /(labs?|finance|protocol|network|foundation|capital|markets?)$/.test(first)) return [];
  return ["labs", "finance", "protocol", "network"].map((w) => first + w);
}

/** ATS, на яких перевіряємо додаткові варіанти слага. */
const PROBE_EXTRA: AtsProvider[] = ["ashby", "greenhouse", "lever"];

export function domainCandidates(name: string): string[] {
  const s = slugCandidates(name)[0];
  return s ? [`https://${s}.com/`, `https://${s}.io/`, `https://${s}.xyz/`] : [];
}

/** Рядок входу: назва обов'язкова, адреса сайту необов'язкова (список DefiLlama її має). */
export interface Row { company: string; n?: number; site?: string }

export interface Hit {
  company: string;
  jobs: number;           // скільки вакансій віддав ATS
  had: number;            // скільки було з дошки, що закрилась
  provider: AtsProvider;
  slug: string;
  via: "slug" | "site";
  sample: string;         // назва першої вакансії: щоб людина побачила чужу компанію
  sampleUrl: string;
}

const opt = { retries: 0, timeoutMs: 15_000 } as const;

async function probeSlugs(name: string, fast = false): Promise<Hit | null> {
  const plan: Array<[string, readonly AtsProvider[]]> = [
    ...slugCandidates(name).map((s): [string, readonly AtsProvider[]] => [s, fast ? PROBE_EXTRA : PROBE]),
    ...extraSlugCandidates(name).map((s): [string, readonly AtsProvider[]] => [s, PROBE_EXTRA]),
  ];
  for (const [slug, providers] of plan) {
    for (const provider of providers) {
      let jobs;
      try { jobs = await ATS[provider](slug, name, opt); } catch { continue; }
      if (jobs.length === 0) continue;
      return { company: name, jobs: jobs.length, had: 0, provider, slug, via: "slug",
        sample: jobs[0]!.title, sampleUrl: jobs[0]!.url };
    }
  }
  return null;
}

async function probeSite(name: string, sites: readonly string[]): Promise<Hit | null> {
  for (const site of sites) {
    let found;
    try { found = await resolveCompanySite(site, opt); } catch { continue; }
    if (!found) continue;
    const { provider, slug } = found.hit;
    let jobs;
    try { jobs = await ATS[provider](slug, name, opt); } catch { continue; }
    if (jobs.length === 0) continue;
    return { company: name, jobs: jobs.length, had: 0, provider, slug, via: "site",
      sample: jobs[0]!.title, sampleUrl: jobs[0]!.url };
  }
  return null;
}

export interface RecoverOptions {
  /** Лише сторінка кар'єри за відомою адресою: для довгих списків, де здогади про слаг надто дорогі. */
  siteOnly?: boolean;
  /** Лише три найчастіші ATS і жодних здогадів про домен: для списків у тисячу назв. */
  fast?: boolean;
  concurrency?: number;
}

export async function recover(rows: ReadonlyArray<Row>, log: (s: string) => void, o: RecoverOptions = {}): Promise<{ hits: Hit[]; misses: string[] }> {
  const hits: Hit[] = [];
  const misses: string[] = [];
  await mapLimit(rows, o.concurrency ?? 4, async (row) => {
    const name = row.company;
    if (isNonCryptoCompany(companyKey(name), name)) { log(`− ${name}: не крипто (список добірки)`); return; }
    // Відома адреса сайту точніша за здогад про слаг: ATS беремо з їхньої ж сторінки кар'єри.
    const known = row.site ? [row.site] : [];
    const hit = (known.length ? await probeSite(name, known) : null)
      ?? (o.siteOnly ? null
        : (await probeSlugs(name, o.fast)) ?? (o.fast ? null : await probeSite(name, domainCandidates(name))));
    if (!hit) { misses.push(name); log(`· ${name}: ATS не знайдено`); return; }
    hit.had = row.n ?? 0;
    hits.push(hit);
    log(`+ ${name}: ${hit.provider}:${hit.slug} (${hit.jobs} вакансій, було ${hit.had}, ${hit.via})`);
  });
  hits.sort((a, b) => b.jobs - a.jobs);
  return { hits, misses };
}

/** INSERT для db/jobs: ключ (ats_provider, ats_slug) унікальний, тож повтор мовчки пропускається. */
export function sqlFor(hits: readonly Hit[]): string {
  const esc = (s: string): string => s.replace(/'/g, "''");
  const lines = hits.map((h) =>
    `INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note)\n` +
    ` VALUES ('${esc(atsSourceKey(h.provider, h.slug))}', '${esc(h.company)}', '${h.provider}', '${esc(h.slug)}', 1, 'recover-ats-2026-09-17', 'заміна закритому board:jobstash: ${h.jobs} вакансій на власній дошці');`);
  return `-- 17.09.2026: компанії, чиї вакансії зникли разом із закритим board:jobstash, повернуті з їхніх власних дощок ATS.\n-- Знайдено scripts/recover-ats.ts (слаг з назви або сторінка кар'єри), кожна дошка перевірена живою відповіддю API.\n${lines.join("\n")}\n`;
}

async function main(argv: string[]): Promise<void> {
  const [file] = argv;
  if (!file) { console.error("usage: recover-ats.ts <companies.json> [--out f] [--sql f] [--limit N]"); process.exit(2); }
  const arg = (k: string): string | undefined => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const limit = Number(arg("--limit") ?? 0);
  let rows = JSON.parse(readFileSync(file, "utf8")) as Row[];
  if (limit > 0) rows = rows.slice(0, limit);
  const { hits, misses } = await recover(rows, (s) => console.log(s),
    { siteOnly: argv.includes("--site-only"), fast: argv.includes("--fast"),
      concurrency: Number(arg("--concurrency") ?? 0) || undefined });
  const found = hits.reduce((n, h) => n + h.jobs, 0);
  console.log(`\nкомпаній ${rows.length}: знайдено ${hits.length}, вакансій на їхніх дошках ${found}; не знайдено ${misses.length}`);
  const out = arg("--out"); if (out) writeFileSync(out, JSON.stringify({ hits, misses }, null, 1));
  const sql = arg("--sql"); if (sql && hits.length) writeFileSync(sql, sqlFor(hits));
}

if (process.argv[1]?.endsWith("recover-ats.ts")) await main(process.argv.slice(2));
