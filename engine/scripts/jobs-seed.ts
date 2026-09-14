/**
 * Засів бази вакансій NextCryptoJob. Разовий інструмент, у роботі сканера не бере участі.
 *
 *   npx tsx scripts/jobs-seed.ts export --wrangler crypto-jobs-agent [--out <file>]   # через wrangler, де вже є вхід
 *   CF_ACCOUNT_ID=… CF_API_TOKEN=… npx tsx scripts/jobs-seed.ts export --database <id> [--out <file>]
 *   npx tsx scripts/jobs-seed.ts build [--export <file>]      # → db/jobs/seed/registry.json
 *   npx tsx scripts/jobs-seed.ts sql                          # → db/jobs/seed/seed.sql
 *   npx tsx scripts/jobs-seed.ts update                       # → db/jobs/seed/update-2026-09-14-web3career.sql
 *
 * `export` один раз (14.09.2026) прочитав з бази NextRole (D1 `crypto-jobs-agent`, той самий власник)
 * лише публічні дані: роботодавців з тегом web3 (назва, ATS, слаг), глобальні дошки (назва, адреса
 * стрічки) і крипто-колекції Getro (номер, назва, адреса). Лише SELECT: клієнт загорнуто в
 * readOnlyJobsDb, який відкидає будь-що, крім однієї інструкції SELECT/WITH. Нічого про людей,
 * добірки чи збіги. Після засіву NextCryptoJob від тієї бази не залежить: скрипт більше не потрібен.
 *
 * `build` робить з експорту реєстр: лише відомі ATS, без не-крипто компаній, дошки з рішеннями про
 * умови (engine/deploy/README.md), плюс кілька роботодавців, перевірених руками (CURATED).
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { D1Client } from "../src/d1.js";
import { companyKey, isNonCryptoCompany } from "../src/digest/clean.js";
import { assertReadOnlySql, readOnlyJobsDb, type JobsDb } from "../src/digest/jobs-db.js";
import { hostSlug } from "../src/jobs/sources/ats.js";
import { registryUpdateSql, type SeedCompany, type SeedGetro, type SeedRegistry, type SeedSource, seedProblems, seedSql } from "../src/jobs/seed.js";
import { isAtsProvider } from "../src/jobs/types.js";

const SEED_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../db/jobs/seed");
export const EXPORT_FILE = resolve(SEED_DIR, "nextrole-export-2026-09-14.json");
export const REGISTRY_FILE = resolve(SEED_DIR, "registry.json");
export const SQL_FILE = resolve(SEED_DIR, "seed.sql");

/**
 * Доповнення живої бази 14.09.2026 (web3.career через API): п'ять роботодавців, чиї вакансії API не
 * віддає, і нові feed_url/terms_note дошки web3.career. Файл робить `update`; тест звіряє.
 */
export const UPDATE_2026_09_14 = {
  name: "registry_2026_09_14_web3career",
  note: "web3.career через офіційний API: 5 роботодавців з їхніми дошками Greenhouse і нові умови дошки web3.career",
  companies: ["bcb-group", "blue-cube-services", "dv-trading", "localcoin", "tastylive"],
  sources: ["board:web3career"],
  file: resolve(SEED_DIR, "update-2026-09-14-web3career.sql"),
} as const;

/** Запити експорту: лише публічні стовпці. Звіряє тест (жодних інших полів у файлі). */
export const EXPORT_QUERIES = {
  companies: `SELECT slug, name, ats_provider, ats_slug, discovered_via FROM companies
 WHERE tags LIKE '%"web3"%' ORDER BY slug`,
  boards: `SELECT name, label, feed_url, kind, enabled FROM country_boards WHERE country = '*' ORDER BY name`,
  getro_collections: `SELECT collection_id, label, url, enabled FROM getro_collections
 WHERE tags LIKE '%"web3"%' ORDER BY collection_id`,
} as const;

export interface ExportFile {
  exported_at: string;
  database: string;
  queries: typeof EXPORT_QUERIES;
  companies: Array<{ slug: string; name: string; ats_provider: string | null; ats_slug: string | null; discovered_via: string | null }>;
  boards: Array<{ name: string; label: string; feed_url: string; kind: string; enabled: number }>;
  getro_collections: Array<{ collection_id: number; label: string; url: string | null; enabled: number }>;
}

/**
 * Роботодавці з тегом web3, які насправді не крипто: тег прийшов від колекції Getro цілком (фонд
 * інвестує й поза криптою). goTenna, Bugcrowd, Anomali і MadHive названо у звіті про вакансії 13.09
 * (розділ 1, «clearly non-crypto»), решту відібрано за публічним описом компанії під час засіву. Вони йдуть у реєстр
 * ВИМКНЕНИМИ (enabled = 0) з причиною: помилку виправляє один UPDATE, без нового засіву.
 * Ключ = companyKey(назва), engine/src/digest/clean.ts.
 */
export const SEED_DISABLED: Readonly<Record<string, string>> = {
  gotenna: "mesh networking hardware",
  bugcrowd: "general bug bounty platform",
  anomali: "threat intelligence",
  madhive: "TV advertising",
  "bluenote health": "healthcare",
  "general catalyst": "venture firm, not a crypto employer",
  shapeways: "3D printing",
  simscale: "engineering simulation software",
  simulmedia: "TV advertising",
  "sofar sounds": "live music events",
  yieldmo: "advertising",
  oxio: "telecom",
  antimetal: "cloud cost software",
  "san francisco compute company": "GPU compute",
  drivewealth: "brokerage infrastructure",
  "possible finance": "consumer lending",
  gamesight: "game marketing",
  xpansiv: "environmental commodities",
  "niobium microsystems": "encryption hardware",
  pqshield: "post-quantum cryptography, not crypto assets",
  dassana: "security data software",
  button: "mobile commerce",
};

/**
 * Дошки, що в день засіву не відповідали: 404 від API ATS або сторінка замість JSON (скан насухо
 * 14.09.2026 з цим самим реєстром). Для частини поруч уже є жива дошка тієї ж компанії з правильним
 * слагом (Lido на ashby:lido.fi, Monad на ashby:monad.foundation, Sui на ashby:Sui%20Foundation тощо).
 * Ідуть у реєстр вимкненими: скан їх не читає, розвідка не додає вдруге. Ключ = `<ats>:<слаг>`.
 */
export const DEAD_AT_SEED: ReadonlySet<string> = new Set([
  "lever:akashnetwork", "bamboohr:algorandfoundation", "ashby:asymmetric", "lever:biconomy", "ashby:chainlink-labs",
  "ashby:dourolabs", "lever:espresso", "bamboohr:fsl", "workable:gelato-digital", "lever:hivemapper", "ashby:lido",
  "ashby:monad", "ashby:nexus", "lever:rarible", "ashby:solana", "ashby:sound", "lever:spectral", "ashby:sui",
  "ashby:tools", "greenhouse:valorainc", "bamboohr:web3", "ashby:xmtp",
]);

/**
 * Руками перевірені роботодавці, яких у експорті немає (ATS, що NextRole не читає).
 * Crossmint: crossmint.com/careers веде на crossmint.na.teamtailor.com, 14.09 5 вакансій.
 *
 * 14.09.2026, після переходу web3.career на офіційний API: роботодавці, чиї вакансії web3.career
 * показував на сайті, але API не віддає (3 і більше таких вакансій). Із 22 таких роботодавців 17 уже в
 * реєстрі; ці п'ять додано. Кожну дошку перевірено живою відповіддю Greenhouse Job Board API (публічний
 * API для показу вакансій на чужих сайтах) і посиланням з сайту самої компанії або назвою дошки.
 */
export const CURATED: readonly SeedCompany[] = [
  { slug: "crossmint", name: "Crossmint", ats_provider: "teamtailor", ats_slug: "crossmint.na", discovered_via: "curated", enabled: 1,
    note: "crossmint.com/careers links crossmint.na.teamtailor.com (jobs.rss, 5 open on 2026-09-14)" },
  { slug: "dv-trading", name: "DV Trading", ats_provider: "greenhouse", ats_slug: "dvtrading", discovered_via: "curated", enabled: 1,
    note: "board name 'DV Trading' (67 open, 18 posted within 30 days on 2026-09-14); proprietary trading firm with the crypto desk DV Chain, all roles also listed by web3.career" },
  { slug: "tastylive", name: "tastylive", ats_provider: "greenhouse", ats_slug: "tastylive", discovered_via: "curated", enabled: 1,
    note: "tastylive.com/careers links boards.greenhouse.io/tastylive (15 open on 2026-09-14); listed by web3.career" },
  { slug: "localcoin", name: "Localcoin", ats_provider: "greenhouse", ats_slug: "localcoin", discovered_via: "curated", enabled: 1,
    note: "localcoinatm.com/careers links boards.greenhouse.io/localcoin (5 open on 2026-09-14); Bitcoin ATM operator" },
  { slug: "blue-cube-services", name: "Blue Cube Services", ats_provider: "greenhouse", ats_slug: "bluecubeservices", discovered_via: "curated", enabled: 1,
    note: "board name 'Blue Cube Services', customer and user operations for crypto partners (8 open on 2026-09-14); listed by web3.career" },
  { slug: "bcb-group", name: "BCB Group", ats_provider: "greenhouse", ats_slug: "bcbgroup", discovered_via: "curated", enabled: 1,
    note: "board name 'BCB Group' on the EU Greenhouse host (1 open on 2026-09-14; bcbgroup.com/careers lists the same role); crypto payments" },
];

/**
 * Дошки. Беремо лише крипто-дошки, і кожну з рішенням про умови (перевірено 13.09, каталог джерел
 * NextRole §11 і звіт 13.09). Ключ = назва дошки в експорті.
 */
const BOARD_DECISIONS: Record<string, Omit<SeedSource, "feed_url"> & { feed?: string } | { skip: string }> = {
  // kind лишився 'jsonld' (CHECK у db/jobs/0001_schema.sql); скан читає цю дошку лише через API за назвою.
  "board:global-web3career": {
    name: "board:web3career", label: "Web3.career", kind: "jsonld", site_url: "https://web3.career", crypto_only: 1, enabled: 1,
    feed: "https://web3.career/api/v1",
    terms_note: "official Web3 Jobs API with our token (WEB3CAREER_TOKEN, since 2026-09-14), read by src/jobs/sources/web3career.ts whatever the kind; terms: link to apply_url unchanged with a follow link (no nofollow, no added params), name web3.career as the source, token private",
  },
  "board:global-jobstash": {
    name: "board:jobstash", label: "JobStash", kind: "nextjs", site_url: "https://jobstash.xyz", crypto_only: 0, enabled: 1,
    terms_note: "no terms found, robots.txt Allow: /; only jobs the board itself marks crypto are kept",
  },
  "board:global-remote3": {
    name: "board:remote3", label: "Remote3", kind: "rss", site_url: "https://remote3.co", crypto_only: 1, enabled: 1,
    feed: "https://www.remote3.co/api/rss",
    terms_note: "their own RSS only (/api/rss); terms forbid automated searches of the site, so no HTML",
  },
  "board:global-cryptocurrencyjobs": { skip: "terms forbid scraping, crawling and bulk republishing" },
  "board:global-cryptocareers": { skip: "terms forbid crawling and automated collection; never gave a row" },
};

const SPEEDRUN: SeedSource = {
  name: "aggregator:speedrun", label: "a16z speedrun", kind: "speedrun", feed_url: "https://speedrun-talent-network.com/api/v1",
  site_url: "https://speedrun-talent-network.com", crypto_only: 1, enabled: 1,
  terms_note: "documented open API (/developers: reads are open and unauthenticated); we pass ?source= and keep their links",
};

function validAtsSlug(provider: string, slug: string): boolean {
  if (["workable", "smartrecruiters", "recruitee", "breezy", "bamboohr", "rippling", "personio"].includes(provider)) {
    try { hostSlug(slug, provider); return true; } catch { return false; }
  }
  return /^[a-z0-9][a-z0-9_.%-]{0,80}$/i.test(slug) && !slug.includes("..");
}

/** Реєстр з експорту. Чиста функція: її перевіряє тест і нею ж зроблено registry.json. */
export function buildRegistry(ex: ExportFile): { registry: SeedRegistry; skipped: Array<{ slug: string; why: string }> } {
  const skipped: Array<{ slug: string; why: string }> = [];
  const companies: SeedCompany[] = [];
  const boards = new Set<string>();
  const slugs = new Set<string>();
  const add = (c: SeedCompany) => {
    const board = `${c.ats_provider}:${c.ats_slug.toLowerCase()}`;
    if (boards.has(board)) { skipped.push({ slug: c.slug, why: `board ${board} already listed` }); return; }
    if (slugs.has(c.slug)) { skipped.push({ slug: c.slug, why: "slug already listed" }); return; }
    boards.add(board); slugs.add(c.slug); companies.push(c);
  };
  for (const c of ex.companies) {
    const provider = c.ats_provider ?? "";
    const atsSlug = (c.ats_slug ?? "").trim();
    if (!isAtsProvider(provider)) { skipped.push({ slug: c.slug, why: `ATS ${provider || "unknown"} is not read` }); continue; }
    if (!atsSlug || !validAtsSlug(provider, atsSlug)) { skipped.push({ slug: c.slug, why: "no usable ATS slug" }); continue; }
    const key = companyKey(c.name);
    if (isNonCryptoCompany(key, c.name)) { skipped.push({ slug: c.slug, why: "on the non-crypto company list" }); continue; }
    const off = SEED_DISABLED[key] ? `disabled at seed: not crypto (${SEED_DISABLED[key]})`
      : DEAD_AT_SEED.has(`${provider}:${atsSlug.toLowerCase()}`) ? "disabled at seed: the ATS board did not answer on 2026-09-14" : null;
    add({ slug: c.slug, name: c.name.trim(), ats_provider: provider, ats_slug: atsSlug, discovered_via: "seed",
      enabled: off ? 0 : 1, note: off });
  }
  for (const c of CURATED) add(c);

  const sources: SeedSource[] = [];
  for (const b of ex.boards) {
    const d = BOARD_DECISIONS[b.name];
    if (!d || "skip" in d) continue;
    const { feed, ...rest } = d;
    sources.push({ ...rest, feed_url: feed ?? b.feed_url });
  }
  sources.push(SPEEDRUN);
  sources.sort((a, b) => a.name.localeCompare(b.name));

  const getro: SeedGetro[] = ex.getro_collections.map((g) => ({
    collection_id: Number(g.collection_id), label: g.label, url: g.url, enabled: 1 as const,
  }));
  companies.sort((a, b) => a.slug.localeCompare(b.slug));
  return {
    registry: {
      version: 1,
      source: `public registry fields exported once from the NextRole job database on ${ex.exported_at.slice(0, 10)} ` +
        "(companies tagged web3, global boards, crypto Getro collections) plus hand-checked additions; see engine/scripts/jobs-seed.ts",
      companies, sources, getro_collections: getro,
    },
    skipped,
  };
}

/**
 * SELECT через `wrangler d1 execute --remote --json` (вхід wrangler уже є на машині власника,
 * токен у скрипт не потрапляє). Та сама межа: кожен запит спершу проходить assertReadOnlySql.
 */
function wranglerSelect(database: string): JobsDb {
  const cwd = resolve(dirname(fileURLToPath(import.meta.url)), "../../web");
  return {
    async select<T>(sql: string) {
      assertReadOnlySql(sql);
      const t0 = performance.now();
      const raw = execFileSync("npx", ["wrangler", "d1", "execute", database, "--remote", "--json", "--command", sql],
        { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
      const [first] = JSON.parse(raw.slice(raw.indexOf("["))) as Array<{ results: T[]; meta?: { rows_read?: number } }>;
      return { rows: first?.results ?? [], meta: { rowsRead: first?.meta?.rows_read ?? null, rowsWritten: null, durationMs: null },
        wallMs: Math.round(performance.now() - t0) };
    },
  };
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main(argv: string[]): Promise<void> {
  const cmd = argv[0];
  if (cmd === "export") {
    const database = arg(argv, "--database");
    const wranglerDb = arg(argv, "--wrangler");
    const out = arg(argv, "--out") ?? EXPORT_FILE;
    const { CF_ACCOUNT_ID, CF_API_TOKEN } = process.env;
    let db: JobsDb;
    if (wranglerDb) {
      db = wranglerSelect(wranglerDb);
    } else {
      if (!database || !CF_ACCOUNT_ID || !CF_API_TOKEN) throw new Error("потрібні --wrangler <назва бази> або --database <id> з CF_ACCOUNT_ID і CF_API_TOKEN");
      // Лише читання: readOnlyJobsDb пропускає тільки одну інструкцію SELECT/WITH.
      db = readOnlyJobsDb(new D1Client({ accountId: CF_ACCOUNT_ID, databaseId: database, token: CF_API_TOKEN }));
    }
    const [companies, boards, getro] = await Promise.all([
      db.select<ExportFile["companies"][number]>(EXPORT_QUERIES.companies),
      db.select<ExportFile["boards"][number]>(EXPORT_QUERIES.boards),
      db.select<ExportFile["getro_collections"][number]>(EXPORT_QUERIES.getro_collections),
    ]);
    const file: ExportFile = {
      exported_at: new Date().toISOString(), database: "crypto-jobs-agent (NextRole), read once with SELECT only",
      queries: EXPORT_QUERIES, companies: companies.rows, boards: boards.rows, getro_collections: getro.rows,
    };
    writeFileSync(out, `${JSON.stringify(file, null, 1)}\n`);
    console.log(`export: ${companies.rows.length} companies, ${boards.rows.length} boards, ${getro.rows.length} Getro collections → ${out}`);
    console.log(`rows_read: ${[companies, boards, getro].map((r) => r.meta.rowsRead ?? "n/a").join(" + ")}`);
    return;
  }
  if (cmd === "build") {
    const ex = JSON.parse(readFileSync(arg(argv, "--export") ?? EXPORT_FILE, "utf8")) as ExportFile;
    const { registry, skipped } = buildRegistry(ex);
    const problems = seedProblems(registry);
    if (problems.length) throw new Error(`реєстр не годиться: ${problems.join("; ")}`);
    writeFileSync(REGISTRY_FILE, `${JSON.stringify(registry, null, 1)}\n`);
    const why = new Map<string, number>();
    for (const s of skipped) why.set(s.why.replace(/:.*$/, ""), (why.get(s.why.replace(/:.*$/, "")) ?? 0) + 1);
    console.log(`build: ${registry.companies.length} companies (${registry.companies.filter((c) => c.enabled === 0).length} disabled), ${registry.sources.length} sources, ` +
      `${registry.getro_collections.length} Getro collections; skipped ${skipped.length} (${[...why].map(([k, n]) => `${k} ${n}`).join(", ")})`);
    return;
  }
  if (cmd === "sql") {
    const registry = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as SeedRegistry;
    writeFileSync(SQL_FILE, seedSql(registry));
    console.log(`sql: ${SQL_FILE}`);
    return;
  }
  if (cmd === "update") {
    const registry = JSON.parse(readFileSync(REGISTRY_FILE, "utf8")) as SeedRegistry;
    writeFileSync(UPDATE_2026_09_14.file, registryUpdateSql(registry, UPDATE_2026_09_14));
    console.log(`update: ${UPDATE_2026_09_14.file}`);
    return;
  }
  throw new Error("команда: export | build | sql | update");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
}
