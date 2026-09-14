// jobs-tokens: зіставлення компанії з монетою CoinGecko і ціни, на справжньому SQLite зі схемою db/jobs
// (з 0004). Мережа підставна: список монет, zksync, usd-coin і /simple/price зі знімків CoinGecko
// 14.09.2026 (sources/fixtures/coingecko-*.json), решта відповідей складена тут.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { companyKey } from "../digest/clean.js";
import { __resetLimiters, __setLimiter, COINGECKO } from "../limits.js";
import { FakeJobsDb } from "../testing/jobs-fake.js";
import { type SeedRegistry, seedSql } from "./seed.js";
import { type JobsBackend, JobsStore } from "./store.js";
import { TOKEN_OVERRIDES } from "./token-overrides.js";
import {
  candidatesFor, coinIndex, domainAliases, homepageConfirms, isCompanyToken, isDue, nameCores, overrideFor, parsePrices,
  runCompanyTokens, runTokenPrices,
} from "./tokens.js";

const fixture = (name: string): string => readFileSync(new URL(`./sources/fixtures/${name}`, import.meta.url), "utf8");
const NOW = new Date("2026-09-14T06:00:00Z");

describe("names", () => {
  it("drops words that do not tell a company from its coin", () => {
    expect(nameCores("Uniswap Labs")).toContain("uniswap");
    expect(nameCores("Polygon Ecosystem Token")).toContain("polygon");
    expect(nameCores("Pyth Network")).toEqual(["pyth network", "pyth"]);
    expect(nameCores("Axiom (axiom.xyz)")).toEqual(expect.arrayContaining(["axiom", "axiom xyz"]));
    expect(nameCores("BOB (Build on Bitcoin)")).toEqual(expect.arrayContaining(["bob", "build on bitcoin"]));
    expect(nameCores("The Graph")).toContain("graph");
    expect(nameCores("Labs")).toEqual(["labs"]);
  });

  it("finds same-name coins in the list, and the domain label too", () => {
    const index = coinIndex(JSON.parse(fixture("coingecko-coins-list.json")));
    expect(candidatesFor("Ethena Labs", "ethena.fi", index)).toEqual(["ethena"]);
    expect(candidatesFor("BOB (Build on Bitcoin)", "gobob.xyz", index).sort()).toEqual(["bob", "bob-2", "bob-6", "bob-build-on-bitcoin"]);
    expect(candidatesFor("Matter Labs", "zksync.io", index)).toEqual(["zksync"]);
    expect(candidatesFor("Acme Protocol", "acme.io", index)).toEqual([]);
    // Тікер кандидата не робить: «USDC» це назва монети usd-coin, а не компанії Circle.
    expect(candidatesFor("Circle", "circle.com", index)).toEqual([]);
  });
});

describe("domain confirmation", () => {
  it("accepts the coin only when its homepage is on the company's registered domain", () => {
    expect(homepageConfirms("lido.fi", ["https://stake.lido.fi/"])).toBe(true);
    expect(homepageConfirms("uniswap.org", ["", "https://app.uniswap.org"])).toBe(true);
    expect(homepageConfirms("binance.com", ["https://www.binance.com?ref=37754157"])).toBe(true);
    expect(homepageConfirms("acme.co.uk", ["https://www.acme.co.uk/"])).toBe(true);
    expect(homepageConfirms("acme.co.uk", ["https://other.co.uk/"])).toBe(false);
    expect(homepageConfirms("acme.io", ["https://acme.io.evil.com/"])).toBe(false);
    expect(homepageConfirms("acme.io", ["https://acme-token.io/"])).toBe(false);
    expect(homepageConfirms("acme.io", [])).toBe(false);
    expect(homepageConfirms("acme.io", "https://acme.io")).toBe(false);
    expect(homepageConfirms("acme.io", [null, 3, "ftp://acme.io", "javascript:acme.io"])).toBe(false);
  });

  it("never confirms on hosts where anyone can have a page", () => {
    expect(homepageConfirms("acme.github.io", ["https://acme.github.io/"])).toBe(false);
    expect(homepageConfirms("acme.io", ["https://github.com/acme", "https://x.com/acme", "https://acme.gitbook.io"])).toBe(false);
    expect(homepageConfirms("medium.com", ["https://medium.com/@acme"])).toBe(false);
  });

  it("takes a known alias from the hand-made list", () => {
    expect(domainAliases("offchainlabs.com")).toEqual(expect.arrayContaining(["arbitrum.io", "arbitrum.foundation"]));
    expect(homepageConfirms("offchainlabs.com", ["https://arbitrum.io/"], domainAliases("offchainlabs.com"))).toBe(true);
    expect(homepageConfirms("offchainlabs.com", ["https://arbitrum.io/"])).toBe(false);
    expect(domainAliases("acme.io")).toEqual([]);
  });

  it("does not take a stablecoin, a wrapped coin or a staking receipt for the company's token", () => {
    expect(isCompanyToken(JSON.parse(fixture("coingecko-coin-usd-coin.json")))).toBe(false);
    expect(isCompanyToken(JSON.parse(fixture("coingecko-coin-zksync.json")))).toBe(true);
    expect(isCompanyToken({ categories: ["Decentralized Finance (DeFi)", "Stablecoin Issuer"] })).toBe(true);
    expect(isCompanyToken({ categories: ["Liquid Staking Governance Tokens"] })).toBe(true);
    expect(isCompanyToken({ categories: ["Liquid Staking Tokens"] })).toBe(false);
    expect(isCompanyToken({ categories: ["Wrapped-Tokens"] })).toBe(false);
    expect(isCompanyToken({ categories: ["Tokenized Gold"] })).toBe(false);
    expect(isCompanyToken({})).toBe(true);
  });
});

describe("hand-made pairs", () => {
  it("match by the full company name or the domain", () => {
    expect(overrideFor("Uniswap Labs", null)?.coingeckoId).toBe("uniswap");
    expect(overrideFor("Offchain Labs", null)?.coingeckoId).toBe("arbitrum");
    expect(overrideFor("OCL", "offchainlabs.com")?.coingeckoId).toBe("arbitrum");
    expect(overrideFor("Douro Labs", "dourolabs.xyz")?.coingeckoId).toBe("pyth-network");
    expect(overrideFor("Coinbase", "coinbase.com")).toMatchObject({ coingeckoId: null, symbol: null });
    expect(overrideFor("Kraken", null)).toMatchObject({ coingeckoId: null });
    // Не за частиною назви.
    expect(overrideFor("Wormhole (Asymmetric)", "asymmetric.re")).toBeNull();
    expect(overrideFor("Acme", "acme.io")).toBeNull();
  });

  it("are well formed: names in companyKey form, a ticker with each id, no repeats", () => {
    const names = new Set<string>();
    for (const o of TOKEN_OVERRIDES) {
      for (const n of o.names) {
        expect(companyKey(n)).toBe(n);
        expect(names.has(n)).toBe(false);
        names.add(n);
      }
      if (o.coingeckoId) {
        expect(o.coingeckoId).toMatch(/^[a-z0-9][a-z0-9-]*$/);
        expect(o.symbol).toMatch(/^[A-Z0-9]{1,12}$/);
      } else {
        expect(o.symbol).toBeNull();
      }
    }
    // Ті, що просив власник (id перевірено живим /coins/{id} 14.09.2026).
    const byName = (n: string) => TOKEN_OVERRIDES.find((o) => o.names.includes(n))?.coingeckoId;
    expect({
      aave: byName("aave"), uniswap: byName("uniswap labs"), arbitrum: byName("offchain labs"), solana: byName("solana foundation"),
      jupiter: byName("jupiter"), chainlink: byName("chainlink labs"), optimism: byName("optimism"), polygon: byName("polygon"),
      okx: byName("okx"), binance: byName("binance"), coinbase: byName("coinbase"), kraken: byName("kraken"), lido: byName("lido"),
      eigen: byName("eigenlayer"), wormhole: byName("wormhole"), jito: byName("jito"), pyth: byName("douro labs"),
    }).toEqual({
      aave: "aave", uniswap: "uniswap", arbitrum: "arbitrum", solana: "solana", jupiter: "jupiter-exchange-solana", chainlink: "chainlink",
      optimism: "optimism", polygon: "polygon-ecosystem-token", okx: "okb", binance: "binancecoin", coinbase: null, kraken: null,
      lido: "lido-dao", eigen: "eigenlayer", wormhole: "wormhole", jito: "jito-governance-token", pyth: "pyth-network",
    });
  });
});

describe("when to look again", () => {
  const row = (confidence: string | null, checked: string | null) => ({ slug: "x", name: "X", enabled: 1, domain: "x.io",
    coingecko_id: null, token_symbol: null, token_confidence: confidence, token_checked_at: checked });
  it("looks for new companies and for 'not found' after 28 days, never again for a confirmed one", () => {
    expect(isDue(row(null, null), NOW)).toBe(true);
    expect(isDue(row("none", "2026-09-09T06:00:00Z"), NOW)).toBe(false);
    expect(isDue(row("none", "2026-08-10T06:00:00Z"), NOW)).toBe(true);
    expect(isDue(row("homepage", "2026-01-01T00:00:00Z"), NOW)).toBe(false);
    // Пара руками, якої вже немає у файлі: шукаємо, як нову.
    expect(isDue(row("override", "2026-09-13T00:00:00Z"), NOW)).toBe(true);
  });
});

describe("prices", () => {
  it("reads /simple/price and skips coins without a dollar price", () => {
    const body = JSON.parse(fixture("coingecko-simple-price.json"));
    const later = new Date("2026-09-14T14:00:00Z");
    expect(parsePrices(body, ["arbitrum", "okb", "gone-coin"], later)).toEqual([
      { coingeckoId: "arbitrum", priceUsd: 0.134808, mcapUsd: 900259555.2568879, change24h: -2.235756452872026, updatedAt: "2026-09-14T13:53:40.000Z" },
      { coingeckoId: "okb", priceUsd: 113.96, mcapUsd: 2393040075.9631395, change24h: 1.1307794092898111, updatedAt: "2026-09-14T13:53:40.000Z" },
    ]);
    // Час ціни з майбутнього (годинник сервера відстає): береться «зараз».
    expect(parsePrices(body, ["okb"], NOW)[0]!.updatedAt).toBe(NOW.toISOString());
    expect(parsePrices({ a: { usd: 0 }, b: { usd: "1" }, c: { usd: 2, usd_market_cap: 0 } }, ["a", "b", "c"], NOW))
      .toEqual([{ coingeckoId: "c", priceUsd: 2, mcapUsd: null, change24h: null, updatedAt: NOW.toISOString() }]);
    expect(parsePrices(null, ["a"], NOW)).toEqual([]);
  });
});

// ---------------- прогін ----------------

const REGISTRY: SeedRegistry = {
  version: 1, source: "test",
  companies: [
    { slug: "uniswap", name: "Uniswap Labs", ats_provider: "greenhouse", ats_slug: "uniswaplabs", discovered_via: "seed", enabled: 1, note: null },
    { slug: "coinbase", name: "Coinbase", ats_provider: "greenhouse", ats_slug: "coinbase", discovered_via: "seed", enabled: 1, note: null },
    { slug: "jito", name: "Jito Labs", ats_provider: "ashby", ats_slug: "jito", discovered_via: "seed", enabled: 1, note: null },
    { slug: "jito-2", name: "Jito Labs", ats_provider: "lever", ats_slug: "jito", discovered_via: "seed", enabled: 1, note: null },
    { slug: "zk", name: "ZKsync", ats_provider: "ashby", ats_slug: "zksync", discovered_via: "seed", enabled: 1, note: null },
    { slug: "ethena", name: "Ethena Labs", ats_provider: "ashby", ats_slug: "ethena", discovered_via: "seed", enabled: 1, note: null },
    { slug: "tether", name: "Tether", ats_provider: "recruitee", ats_slug: "tether", discovered_via: "seed", enabled: 1, note: null },
    { slug: "legend", name: "Legend", ats_provider: "ashby", ats_slug: "legend", discovered_via: "seed", enabled: 1, note: null },
    { slug: "bob", name: "BOB (Build on Bitcoin)", ats_provider: "ashby", ats_slug: "bob", discovered_via: "seed", enabled: 1, note: null },
    { slug: "acme", name: "Acme Protocol", ats_provider: "lever", ats_slug: "acme", discovered_via: "seed", enabled: 1, note: null },
    { slug: "allora-nodomain", name: "Allora Labs", ats_provider: "lever", ats_slug: "allora", discovered_via: "seed", enabled: 1, note: null },
    { slug: "axiom", name: "Axiom (axiom.xyz)", ats_provider: "ashby", ats_slug: "axiom", discovered_via: "seed", enabled: 1, note: null },
    { slug: "allora", name: "Allora Foundation", ats_provider: "ashby", ats_slug: "allora", discovered_via: "seed", enabled: 1, note: null },
  ],
  sources: [],
  getro_collections: [],
};

const DOMAINS: Record<string, string> = {
  uniswap: "uniswap.org", coinbase: "coinbase.com", zk: "zksync.io", ethena: "ethena.fi", tether: "tether.to", legend: "legend.xyz",
  bob: "gobob.xyz", acme: "acme.io", axiom: "axiom.xyz", allora: "allora.network",
};

/** Складені відповіді /coins/{id}; zksync і usd-coin зі знімків. */
const COINS: Record<string, object> = {
  zksync: JSON.parse(fixture("coingecko-coin-zksync.json")),
  ethena: { id: "ethena", symbol: "ena", name: "Ethena", categories: ["Decentralized Finance (DeFi)"], links: { homepage: ["https://ethena.fi/", ""] } },
  tether: { id: "tether", symbol: "usdt", name: "Tether", categories: ["Stablecoins", "USD Stablecoin"], links: { homepage: ["https://tether.to/"] } },
  "legend-2": { id: "legend-2", symbol: "legend", name: "Legend", categories: ["Meme"], links: { homepage: ["https://legendtoken.io"] } },
  "legend-3": { id: "legend-3", symbol: "$legend", name: "Legend", categories: [], links: { homepage: ["https://legend.xyz.scam.io/"] } },
  "bob-build-on-bitcoin": { id: "bob-build-on-bitcoin", symbol: "bob", name: "BOB (Build on Bitcoin)", categories: ["Layer 2 (L2)"],
    links: { homepage: ["https://www.gobob.xyz/"] } },
  allora: { id: "allora", symbol: "allo", name: "Allora", categories: ["Artificial Intelligence (AI)"], links: { homepage: ["https://www.allora.network/"] } },
};

/** Капіталізація для /coins/markets; монети поза списком CoinGecko «не знає» (мертві). */
const MCAP: Record<string, number> = {
  zksync: 280e6, ethena: 2.1e9, "ethena-usde": 9e9, tether: 170e9, "legend-2": 5e6, "legend-3": 1e6, bob: 10e6, "bob-2": 1e3,
  "bob-build-on-bitcoin": 50e6, allora: 30e6, uniswap: 5e9, "jito-governance-token": 400e6, arbitrum: 900e6,
};
for (const o of TOKEN_OVERRIDES) if (o.coingeckoId && !(o.coingeckoId in MCAP)) MCAP[o.coingeckoId] = 1e8;

let db: FakeJobsDb;
let urls: string[];
let headers: Array<Record<string, string>>;
/** Скільки разів поспіль відповісти 429 на шлях, що містить ключ. */
let throttle: Record<string, number>;
let priceStatus: number;

const json = (body: unknown, status = 200) => new Response(typeof body === "string" ? body : JSON.stringify(body),
  { status, headers: { "content-type": "application/json" } });

const fetchImpl = (async (input: string, init?: RequestInit) => {
  const url = new URL(String(input));
  urls.push(url.toString());
  headers.push(Object.fromEntries(new Headers(init?.headers).entries()));
  for (const [part, n] of Object.entries(throttle)) {
    if (url.pathname.includes(part) && n > 0) {
      throttle[part] = n - 1;
      return new Response("rate limited", { status: 429, headers: { "retry-after": "0" } });
    }
  }
  if (url.hostname !== "api.coingecko.com") return new Response("unexpected", { status: 500 });
  if (url.pathname === "/api/v3/coins/list") return json(fixture("coingecko-coins-list.json"));
  if (url.pathname === "/api/v3/coins/markets") {
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter((id) => id in MCAP);
    return json(ids.map((id) => ({ id, symbol: id.slice(0, 4), name: id, market_cap: MCAP[id] })));
  }
  if (url.pathname === "/api/v3/simple/price") {
    if (priceStatus !== 200) return new Response("down", { status: priceStatus });
    const ids = (url.searchParams.get("ids") ?? "").split(",");
    const all = JSON.parse(fixture("coingecko-simple-price.json")) as Record<string, unknown>;
    const extra: Record<string, unknown> = { zksync: { usd: 0.0512, usd_market_cap: 280e6, usd_24h_change: 3.14, last_updated_at: 1789394020 } };
    return json(Object.fromEntries(ids.filter((id) => all[id] || extra[id]).map((id) => [id, all[id] ?? extra[id]])));
  }
  const m = /^\/api\/v3\/coins\/([^/]+)$/.exec(url.pathname);
  if (m && COINS[decodeURIComponent(m[1]!)]) return json(COINS[decodeURIComponent(m[1]!)]);
  return new Response("not found", { status: 404 });
}) as unknown as typeof fetch;

const run = (store: JobsStore, env: Record<string, string> = {}, extra: Partial<Parameters<typeof runCompanyTokens>[0]> = {}) =>
  runCompanyTokens({ store, env, now: NOW, log: () => undefined, fetch: { fetchImpl, retryDelayMs: 0 }, ...extra });

type Row = { slug: string; coingecko_id: string | null; token_symbol: string | null; token_confidence: string | null;
  token_checked_at: string | null; token_price_usd: number | null; token_mcap_usd: number | null; token_change_24h: number | null; token_updated_at: string | null };
const rows = () => Object.fromEntries(db.all<Row>(
  `SELECT slug, coingecko_id, token_symbol, token_confidence, token_checked_at, token_price_usd, token_mcap_usd, token_change_24h,
          token_updated_at FROM companies ORDER BY slug`).map((r) => [r.slug, r]));
const cgCalls = (path: string) => urls.filter((u) => u.includes(`api.coingecko.com/api/v3${path}`)).length;

beforeEach(() => {
  __resetLimiters();
  __setLimiter(COINGECKO, { concurrency: 1, minIntervalMs: 0 });
  db = new FakeJobsDb(NOW);
  db.sqlite.exec(seedSql(REGISTRY));
  for (const [slug, d] of Object.entries(DOMAINS)) db.exec("UPDATE companies SET domain = ? WHERE slug = ?", d, slug);
  // Axiom перевірено 5 днів тому (ще рано), Allora Foundation 40 днів тому (пора знову).
  db.exec("UPDATE companies SET token_confidence = 'none', token_checked_at = '2026-09-09T06:00:00.000Z' WHERE slug = 'axiom'");
  db.exec("UPDATE companies SET token_confidence = 'none', token_checked_at = '2026-08-05T06:00:00.000Z' WHERE slug = 'allora'");
  urls = [];
  headers = [];
  throttle = {};
  priceStatus = 200;
  db.seen.length = 0;
});
afterEach(() => db.close());

describe("jobs-tokens", () => {
  it("maps by hand first, then only coins whose homepage is the company's domain", async () => {
    const r = await run(new JobsStore(db, false));
    const b = rows();
    // Руками: без жодного запиту за монетою; обидва рядки Jito Labs, навіть без домену.
    expect(b.uniswap).toMatchObject({ coingecko_id: "uniswap", token_symbol: "UNI", token_confidence: "override" });
    expect(b.coinbase).toMatchObject({ coingecko_id: null, token_symbol: null, token_confidence: "override" });
    expect(b.jito).toMatchObject({ coingecko_id: "jito-governance-token", token_symbol: "JTO", token_confidence: "override" });
    expect(b["jito-2"]).toMatchObject({ coingecko_id: "jito-governance-token", token_confidence: "override" });
    // Доменом: ZKsync (знімок), Ethena, BOB (найбільша з чотирьох однойменних), Allora Foundation (пора перевірити знову).
    expect(b.zk).toMatchObject({ coingecko_id: "zksync", token_symbol: "ZK", token_confidence: "homepage", token_checked_at: NOW.toISOString() });
    expect(b.ethena).toMatchObject({ coingecko_id: "ethena", token_symbol: "ENA", token_confidence: "homepage" });
    expect(b.bob).toMatchObject({ coingecko_id: "bob-build-on-bitcoin", token_symbol: "BOB", token_confidence: "homepage" });
    expect(b.allora).toMatchObject({ coingecko_id: "allora", token_symbol: "ALLO", token_confidence: "homepage" });
    // Tether: монета є і сайт той самий, але це стейблкоїн. Legend: однойменні монети з чужими сайтами.
    expect(b.tether).toMatchObject({ coingecko_id: null, token_confidence: "none", token_checked_at: NOW.toISOString() });
    expect(b.legend).toMatchObject({ coingecko_id: null, token_confidence: "none" });
    // Без однойменної монети, без домену, перевірене недавно: нічого не записано.
    expect(b.acme).toMatchObject({ coingecko_id: null, token_confidence: null, token_checked_at: null });
    expect(b["allora-nodomain"]).toMatchObject({ coingecko_id: null, token_confidence: null });
    expect(b.axiom).toMatchObject({ token_confidence: "none", token_checked_at: "2026-09-09T06:00:00.000Z" });
    expect(urls.some((u) => u.includes("/coins/axiom"))).toBe(false);

    expect(r).toMatchObject({ confirmed: 4, notFound: 2, deferred: 0, failed: 0, rateLimited: false, withCandidates: 6 });
    // Запити: список 1, пакет кандидатів 1, по монеті: zksync, ethena, bob-build-on-bitcoin, allora, tether, legend-2, legend-3.
    expect({ list: cgCalls("/coins/list"), markets: cgCalls("/coins/markets"), prices: cgCalls("/simple/price") })
      .toEqual({ list: 1, markets: 1, prices: 1 });
    expect(r.calls).toBe(9);
    expect(urls.some((u) => u.includes("/coins/legend-4") || u.includes("/coins/bob-2") || u.includes("/coins/bob?"))).toBe(false);
    expect(r.overrides.unknownIds).toEqual([]);
    expect(r.mapped).toBe(4 + 3);
  });

  it("writes prices for every row of a mapped coin, in one batched call", async () => {
    const r = await run(new JobsStore(db, false));
    expect(r.prices).toMatchObject({ priced: 1, error: null });
    expect(r.prices!.missing).toEqual(expect.arrayContaining(["uniswap", "ethena"]));
    expect(rows().zk).toMatchObject({ token_price_usd: 0.0512, token_mcap_usd: 280e6, token_change_24h: 3.14 });
    expect(cgCalls("/simple/price")).toBe(1);
    const ids = new URL(urls.find((u) => u.includes("/simple/price"))!).searchParams.get("ids")!.split(",");
    expect(ids).toEqual([...ids].sort());
    expect(ids).toEqual(expect.arrayContaining(["zksync", "jito-governance-token", "uniswap", "bob-build-on-bitcoin"]));
  });

  it("settles each company once: a second run makes no coin calls and writes nothing", async () => {
    await run(new JobsStore(db, false), {}, { prices: false });
    const before = JSON.stringify(rows());
    urls = [];
    db.seen.length = 0;
    const r = await run(new JobsStore(db, false), {}, { prices: false });
    expect(JSON.stringify(rows())).toBe(before);
    expect(db.seen.filter((s) => s.startsWith("UPDATE companies"))).toEqual([]);
    // Лишився лише Acme (однойменної монети немає: це безкоштовно) і перевірка пар руками одним пакетом.
    expect(r.due).toBe(1);
    expect(urls.filter((u) => /\/coins\/(?!list|markets)/.test(u))).toEqual([]);
  });

  it("dry run reads and counts, but writes nothing", async () => {
    const store = new JobsStore(db, true);
    const r = await run(store);
    expect(r.dry).toBe(true);
    expect(r.confirmed).toBe(4);
    expect(r.mappings.length).toBeGreaterThan(0);
    expect(store.estimatedRows).toBeGreaterThanOrEqual(r.mappings.length);
    expect(db.seen.some((s) => s.startsWith("UPDATE"))).toBe(false);
    expect(rows().zk!.coingecko_id).toBeNull();
    // Насухо ціни й на нові зіставлення (їх немає в базі), щоб звіт був повний.
    expect(r.prices!.priced).toBe(1);
  });

  it("takes domains the dry run of jobs-about would add", async () => {
    db.exec("UPDATE companies SET domain = NULL WHERE slug = 'zk'");
    const without = await run(new JobsStore(db, true), {}, { prices: false });
    expect(without.matches.some((m) => m.slug === "zk")).toBe(false);
    const withAbout = await run(new JobsStore(db, true), {}, { prices: false, domains: new Map([["zk", "zksync.io"]]) });
    expect(withAbout.matches.find((m) => m.slug === "zk")).toMatchObject({ coingeckoId: "zksync", domain: "zksync.io" });
  });

  it("waits out one 429 and goes on", async () => {
    throttle = { "/coins/list": 1 };
    const r = await run(new JobsStore(db, false), {}, { prices: false });
    expect(cgCalls("/coins/list")).toBe(2);
    expect(r).toMatchObject({ confirmed: 4, rateLimited: false });
  });

  it("stops on a lasting 429, keeps what it found and leaves the rest for next time", async () => {
    // Перша монета (bob-build-on-bitcoin) проходить, далі CoinGecko відповідає 429 на кожну.
    throttle = { "/coins/zksync": 9, "/coins/ethena": 9, "/coins/legend": 9, "/coins/tether": 9, "/coins/allora": 9 };
    const r = await run(new JobsStore(db, false), {}, { prices: false });
    expect(r.rateLimited).toBe(true);
    const b = rows();
    expect(b.bob).toMatchObject({ coingecko_id: "bob-build-on-bitcoin", token_confidence: "homepage" });
    // Ні «не знайдено», ні дати перевірки тим, до кого не дійшли: наступного тижня знову.
    for (const slug of ["zk", "ethena", "legend", "tether"]) expect(b[slug]).toMatchObject({ token_confidence: null, token_checked_at: null });
    expect(b.allora).toMatchObject({ token_confidence: "none", token_checked_at: "2026-08-05T06:00:00.000Z" });
    // Пари руками записано все одно.
    expect(b.uniswap!.token_confidence).toBe("override");
    expect(r.deferred).toBe(5);
    // Після першої відмови по одному повтору, далі жодної спроби.
    expect(urls.filter((u) => /\/coins\/(zksync|ethena|legend|tether|allora)/.test(u)).length).toBe(2);
  });

  it("keeps to the call budget", async () => {
    const r = await run(new JobsStore(db, false), { JOBS_TOKENS_BUDGET: "3" }, { prices: false });
    // Список, пакет і одна монета (BOB іде першим за абеткою серед ніколи не перевірених).
    expect(r.calls).toBe(3);
    expect(r).toMatchObject({ confirmed: 1, deferred: 5, notFound: 0 });
    expect(rows().ethena!.token_checked_at).toBeNull();
  });

  it("with COINGECKO_API_KEY sends the demo key as a header, never in the address", async () => {
    await run(new JobsStore(db, true), { COINGECKO_API_KEY: "demo-secret-123" }, { prices: false });
    expect(headers.every((h) => h["x-cg-demo-api-key"] === "demo-secret-123")).toBe(true);
    expect(urls.some((u) => u.includes("demo-secret-123"))).toBe(false);
    headers = [];
    await run(new JobsStore(db, true), {}, { prices: false });
    expect(headers.some((h) => "x-cg-demo-api-key" in h)).toBe(false);
  });

  it("does nothing, and does not fail, before db/jobs/0004 is applied", async () => {
    const backend: JobsBackend = {
      query: async (sql: string) => {
        if (/coingecko_id|token_/.test(sql)) throw new Error("D1_ERROR: no such column: coingecko_id: SQLITE_ERROR");
        return [];
      },
      batch: async () => { throw new Error("must not write"); },
    };
    const lines: string[] = [];
    const r = await runCompanyTokens({ store: new JobsStore(backend, false), env: {}, log: (l) => lines.push(l), fetch: { fetchImpl } });
    expect(r.skipped).toBe("companies token columns missing");
    const p = await runTokenPrices({ store: new JobsStore(backend, false), env: {}, log: (l) => lines.push(l), fetch: { fetchImpl } });
    expect(p.skipped).toBe("companies token columns missing");
    expect(urls).toEqual([]);
    expect(lines.join("\n")).toContain("0004_company_token.sql");
  });
});

describe("prices after the scan", () => {
  beforeEach(() => {
    db.exec(`UPDATE companies SET coingecko_id = 'arbitrum', token_symbol = 'ARB', token_confidence = 'override',
      token_price_usd = 0.5, token_mcap_usd = 2e9, token_change_24h = 1, token_updated_at = '2026-09-12T00:00:00.000Z' WHERE slug IN ('uniswap', 'acme')`);
    db.exec("UPDATE companies SET coingecko_id = 'solana', token_symbol = 'SOL', token_confidence = 'override' WHERE slug = 'coinbase'");
  });

  it("refreshes every mapped coin with one call and updates each row of it", async () => {
    const r = await runTokenPrices({ store: new JobsStore(db, false), env: {}, now: NOW, log: () => undefined, fetch: { fetchImpl } });
    expect(r).toMatchObject({ ids: 2, priced: 2, missing: [], calls: 1, error: null });
    const b = rows();
    for (const slug of ["uniswap", "acme"]) {
      expect(b[slug]).toMatchObject({ token_price_usd: 0.134808, token_mcap_usd: 900259555.2568879, token_change_24h: -2.235756452872026 });
    }
    expect(b.coinbase!.token_price_usd).toBe(101.5);
    expect(db.seen.filter((s) => s.startsWith("UPDATE companies SET token_price_usd")).length).toBe(2);
  });

  it("keeps the last prices when CoinGecko fails, and never throws", async () => {
    priceStatus = 503;
    const lines: string[] = [];
    const r = await runTokenPrices({ store: new JobsStore(db, false), env: {}, now: NOW, log: (l) => lines.push(l), fetch: { fetchImpl, retries: 0 } });
    expect(r.error).toMatch(/503/);
    expect(rows().uniswap).toMatchObject({ token_price_usd: 0.5, token_updated_at: "2026-09-12T00:00:00.000Z" });
    expect(lines.join("\n")).toMatch(/last prices kept/);
  });

  it("runs after jobs-scan from the command line, and a price failure does not fail the scan", async () => {
    // Скан без джерел (усі компанії вимкнені): лише гачок цін.
    db.exec("UPDATE companies SET enabled = 0");
    priceStatus = 500;
    const out: string[] = [];
    const code = await runCli(["jobs-scan"], { env: {}, jobsBackend: () => db, fetchImpl, out: (l) => out.push(l) });
    expect(code).toBe(0);
    expect(cgCalls("/simple/price")).toBeGreaterThan(0);
    expect(out.join("\n")).toMatch(/jobs-tokens prices: 0 of 2 coins priced.*failed, last prices kept/);
    urls = [];
    expect(await runCli(["jobs-scan"], { env: { JOBS_TOKENS: "0" }, jobsBackend: () => db, fetchImpl, out: () => undefined })).toBe(0);
    expect(urls.some((u) => u.includes("coingecko"))).toBe(false);
  });

  it("jobs-tokens --prices from the command line", async () => {
    const out: string[] = [];
    expect(await runCli(["jobs-tokens", "--prices"], { env: {}, jobsBackend: () => db, fetchImpl, out: (l) => out.push(l) })).toBe(0);
    expect(out.join("\n")).toMatch(/jobs-tokens prices: 2 of 2 coins priced; 1 CoinGecko calls/);
  });
});
