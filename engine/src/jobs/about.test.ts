// jobs-about: домен і опис роботодавця на справжньому SQLite зі схемою db/jobs (з 0005); мережа
// підставна (знімки з sources/fixtures).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../cli.js";
import { __resetLimiters } from "../limits.js";
import { FakeJobsDb } from "../testing/jobs-fake.js";
import { aboutText, companyDomain, domainFromAshbySlug, domainFromJobUrls, domainFromNote, runCompanyAbout } from "./about.js";
import { type SeedRegistry, seedSql } from "./seed.js";
import { type JobsBackend, JobsStore } from "./store.js";

const fixture = (name: string): string => readFileSync(new URL(`./sources/fixtures/${name}`, import.meta.url), "utf8");

describe("aboutText", () => {
  it("takes what the company does from the Greenhouse board, not the pitch question or the candidate text", () => {
    const content = (JSON.parse(fixture("greenhouse-board-coinbase.json")) as { content: string }).content;
    expect(aboutText(content)).toBe("At Coinbase, our mission is to increase economic freedom in the world.");
  });

  it("strips HTML and entities, keeps two sentences when they fit, and has no long dashes", () => {
    const html = "<h3>About us</h3><p>Since 2012, Trail of Bits has helped secure the world&#39;s most targeted organizations &amp; devices. " +
      "We combine security research with an attacker mentality \u2014 to reduce risk.</p><p>We help our clients lead.</p>";
    const out = aboutText(html)!;
    expect(out).toBe("Since 2012, Trail of Bits has helped secure the world's most targeted organizations & devices. " +
      "We combine security research with an attacker mentality - to reduce risk.");
    expect(out).not.toMatch(/[\u2014\u2013<>]/);
  });

  it("reads the Workable account description", () => {
    const d = (JSON.parse(fixture("workable-trailofbits.json")) as { description: string }).description;
    const out = aboutText(d)!;
    expect(out.startsWith("Since 2012, Trail of Bits has helped secure")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(240);
  });

  it("drops headings and sentences about the job", () => {
    const text = "BUILDING THE FUTURE OF OPEN FINANCE\n\nWe are looking for a Senior Engineer. Join our team! " +
      "Payward is the parent company behind Kraken and NinjaTrader. You will own the ledger.";
    expect(aboutText(text)).toBe("Payward is the parent company behind Kraken and NinjaTrader.");
    expect(aboutText("<p>About Acme</p><p>This role reports to the CTO. As a candidate you ship.</p>")).toBeNull();
  });

  it("keeps a decimal inside a sentence and cuts a long one at a word with ...", () => {
    expect(aboutText("Kraken raised $1.5B and serves 10 million clients in 190 countries today.")).toBe(
      "Kraken raised $1.5B and serves 10 million clients in 190 countries today.");
    const long = `Acme builds ${"very ".repeat(80)}fast rails for stablecoin payments.`;
    const out = aboutText(long)!;
    expect(out.length).toBeLessThanOrEqual(240);
    expect(out.endsWith("very...")).toBe(true);
  });

  it("returns null for too little text", () => {
    expect(aboutText("We build.")).toBeNull();
    expect(aboutText("")).toBeNull();
    expect(aboutText(null)).toBeNull();
  });
});

describe("company domain", () => {
  it("takes the company's own host and drops career sub-domains and www", () => {
    expect(companyDomain("https://www.coinbase.com/careers/positions/8093264?gh_jid=8093264")).toBe("coinbase.com");
    expect(companyDomain("https://careers.tether.io/o/technical-lead")).toBe("tether.io");
    expect(companyDomain("https://jobs.kraken.com/x")).toBe("kraken.com");
    expect(companyDomain("https://careers.io/")).toBe("careers.io");
    expect(companyDomain("https://app.uniswap.org/")).toBe("app.uniswap.org");
  });

  it("never names an ATS, board, aggregator or generic host", () => {
    for (const url of [
      "https://job-boards.greenhouse.io/coinbase/jobs/1", "https://jobs.lever.co/crypto/1", "https://jobs.ashbyhq.com/kraken.com/1",
      "https://apply.workable.com/j/1", "https://tether.recruitee.com/o/1", "https://web3.career/r/abc",
      "https://speedrun-talent-network.com/jobs/x", "https://acme.notion.site/jobs", "https://docs.google.com/forms/d/1",
      "https://acme.wd1.myworkdayjobs.com/x", "https://jobs.gem.com/acme", "http://10.0.0.1/", "mailto:jobs@acme.io", "not a url",
    ]) {
      expect({ url, d: companyDomain(url) }).toEqual({ url, d: null });
    }
  });

  it("reads the registry note and an Ashby slug that is a domain", () => {
    expect(domainFromNote("listed on the public portfolio page https://www.paradigm.xyz/investments; company site https://www.3jane.xyz/ careers page https://www.3jane.xyz/ links lever:3jane"))
      .toBe("3jane.xyz");
    expect(domainFromNote("board name 'BCB Group' on the EU Greenhouse host")).toBeNull();
    expect(domainFromAshbySlug("ashby", "kraken.com")).toBe("kraken.com");
    expect(domainFromAshbySlug("ashby", "alchemy")).toBeNull();
    expect(domainFromAshbySlug("teamtailor", "crossmint.na")).toBeNull();
  });

  it("picks the most common own host among job links", () => {
    expect(domainFromJobUrls([
      "https://job-boards.greenhouse.io/x/1", "https://www.acme.io/careers/1", "https://acme.io/careers/2", "https://blog.other.io/x",
    ])).toBe("acme.io");
    expect(domainFromJobUrls(["https://jobs.lever.co/x/1"])).toBeNull();
  });
});

// ---------------- прогін ----------------

const REGISTRY: SeedRegistry = {
  version: 1, source: "test",
  companies: [
    { slug: "coinbase", name: "Coinbase", ats_provider: "greenhouse", ats_slug: "coinbase", discovered_via: "seed", enabled: 1, note: null },
    { slug: "trailofbits", name: "Trail of Bits", ats_provider: "workable", ats_slug: "trailofbits", discovered_via: "seed", enabled: 1, note: null },
    { slug: "kraken", name: "Kraken", ats_provider: "ashby", ats_slug: "kraken.com", discovered_via: "seed", enabled: 1, note: null },
    { slug: "anchorage", name: "Anchorage", ats_provider: "lever", ats_slug: "anchorage", discovered_via: "speedrun", enabled: 1, note: null },
    { slug: "3jane", name: "3Jane", ats_provider: "lever", ats_slug: "3jane", discovered_via: "portfolio:paradigm", enabled: 1,
      note: "listed on the public portfolio page https://www.paradigm.xyz/investments; company site https://www.3jane.xyz/ careers page https://www.3jane.xyz/ links lever:3jane" },
    { slug: "keep", name: "Keep Labs", ats_provider: "greenhouse", ats_slug: "keeplabs", discovered_via: "manual", enabled: 1, note: null },
    { slug: "failco", name: "Fail Co", ats_provider: "greenhouse", ats_slug: "failco", discovered_via: "seed", enabled: 1, note: null },
    { slug: "offgh", name: "Off Co", ats_provider: "greenhouse", ats_slug: "offco", discovered_via: "seed", enabled: 0, note: "disabled at seed" },
  ],
  sources: [],
  getro_collections: [],
};

let db: FakeJobsDb;
let urls: string[];

const fetchImpl = (async (input: string) => {
  const url = String(input);
  urls.push(url);
  const json = (body: string) => new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  if (url === "https://boards-api.greenhouse.io/v1/boards/coinbase") return json(fixture("greenhouse-board-coinbase.json"));
  if (url.startsWith("https://boards-api.greenhouse.io/")) return new Response("down", { status: 500 });
  if (url === "https://apply.workable.com/api/v1/widget/accounts/trailofbits") return json(fixture("workable-trailofbits.json"));
  if (url.includes("/collections/crypto-web3")) return json(fixture("speedrun-collection-crypto.json"));
  if (url.includes("/companies?")) return json(fixture("speedrun-companies-page.json"));
  if (url.includes("/companies/anchorage?")) return json(fixture("speedrun-company-anchorage.json"));
  return new Response("unexpected", { status: 500 });
}) as unknown as typeof fetch;

const run = (store: JobsStore, env: Record<string, string> = {}) =>
  runCompanyAbout({ store, env, log: () => undefined, fetch: { fetchImpl, retries: 0 } });

beforeEach(() => {
  __resetLimiters();
  db = new FakeJobsDb(new Date("2026-09-14T06:00:00Z"));
  db.sqlite.exec(seedSql(REGISTRY));
  db.exec("UPDATE companies SET domain = 'keep.io', about = 'Keep Labs writes this by hand and it stays as it is.' WHERE slug = 'keep'");
  db.add({ id: "c1", title: "Engineer", company: "Coinbase", source: "greenhouse:coinbase" });
  db.exec("UPDATE jobs_cache SET url = 'https://www.coinbase.com/careers/positions/1?gh_jid=1' WHERE id = 'c1'");
  db.add({ id: "c2", title: "Designer", company: "Coinbase", source: "greenhouse:coinbase" });
  db.exec("UPDATE jobs_cache SET url = 'https://job-boards.greenhouse.io/coinbase/jobs/2' WHERE id = 'c2'");
  db.add({ id: "w1", title: "Writer", company: "Board Co", source: "board:web3career" });
  db.exec("UPDATE jobs_cache SET url = 'https://www.boardco.io/jobs/1' WHERE id = 'w1'");
  urls = [];
  db.seen.length = 0;
});
afterEach(() => db.close());

const profiles = () => db.all<{ slug: string; domain: string | null; about: string | null }>(
  "SELECT slug, domain, about FROM companies ORDER BY slug");

describe("jobs-about", () => {
  it("fills only what is missing, from the sources that give it, and never overwrites", async () => {
    const r = await run(new JobsStore(db, false));
    const bySlug = Object.fromEntries(profiles().map((p) => [p.slug, p]));
    expect(bySlug.coinbase).toEqual({ slug: "coinbase", domain: "coinbase.com", about: "At Coinbase, our mission is to increase economic freedom in the world." });
    expect(bySlug.trailofbits!.about!.startsWith("Since 2012, Trail of Bits")).toBe(true);
    expect(bySlug.trailofbits!.domain).toBeNull();
    expect(bySlug.kraken!.domain).toBe("kraken.com");
    expect(bySlug["3jane"]!.domain).toBe("3jane.xyz");
    expect(bySlug.keep).toEqual({ slug: "keep", domain: "keep.io", about: "Keep Labs writes this by hand and it stays as it is." });
    // Вимкнену компанію не питаємо; дошка, що не відповіла, лишає поле порожнім.
    expect(urls.some((u) => u.includes("/boards/offco"))).toBe(false);
    expect(bySlug.offgh!.about).toBeNull();
    // Вакансії дошки (web3.career) домену ATS-компанії не дають.
    expect(Object.values(bySlug).some((p) => p.domain === "boardco.io")).toBe(false);
    expect(r.domains).toEqual({ note: 1, ashby: 1, jobs: 1 });
    // Мережа speedrun знає Anchorage за назвою: її blurb.
    expect(bySlug.anchorage!.about).toMatch(/^Federally chartered crypto bank for institutions/);
    expect(r.about).toEqual({ greenhouse: 1, workable: 1, speedrun: 1 });
    // failco відповів 500: поле порожнє, прогін іде далі; keeplabs з описом не питали.
    expect(bySlug.failco!.about).toBeNull();
    expect(r.failed).toBe(1);
    expect(urls.some((u) => u.includes("/boards/keeplabs"))).toBe(false);
  });

  it("writes one row per changed company, and nothing on a second run", async () => {
    const first = await run(new JobsStore(db, false));
    const updates = db.seen.filter((s) => s.startsWith("UPDATE companies"));
    expect(updates.length).toBe(first.fills.length);
    expect(first.fills.every((f) => f.domain !== null || f.about !== null)).toBe(true);
    const before = JSON.stringify(profiles());
    db.seen.length = 0;
    const second = await run(new JobsStore(db, false));
    expect(JSON.stringify(profiles())).toBe(before);
    // Домени вже є; опис лише там, де його досі немає (запити є, записів немає).
    expect(second.fills.filter((f) => f.domain !== null)).toEqual([]);
    expect(db.seen.filter((s) => s.startsWith("UPDATE companies"))).toEqual([]);
  });

  it("dry run reads and counts, but writes nothing", async () => {
    const store = new JobsStore(db, true);
    const r = await run(store);
    expect(r.dry).toBe(true);
    expect(r.fills.length).toBeGreaterThan(0);
    expect(store.estimatedRows).toBe(r.fills.length);
    expect(db.seen.some((s) => s.startsWith("UPDATE"))).toBe(false);
    expect(profiles().find((p) => p.slug === "coinbase")!.domain).toBeNull();
  });

  it("does nothing, and does not fail, before db/jobs/0005 is applied", async () => {
    const backend: JobsBackend = {
      query: async (sql: string) => {
        if (/\bdomain\b/.test(sql)) throw new Error("D1_ERROR: no such column: domain: SQLITE_ERROR");
        return [];
      },
      batch: async () => { throw new Error("must not write"); },
    };
    const lines: string[] = [];
    const r = await runCompanyAbout({ store: new JobsStore(backend, false), env: {}, log: (l) => lines.push(l), fetch: { fetchImpl, retries: 0 } });
    expect(r.skipped).toBe("companies.domain/about missing");
    expect(urls).toEqual([]);
    expect(lines.join("\n")).toContain("0005_company_profile.sql");
  });

  it("keeps to the request budget", async () => {
    const r = await run(new JobsStore(db, true), { JOBS_ABOUT_BUDGET: "1" });
    expect(r.fetched).toBe(1);
  });

  it("runs from the command line; --dry writes nothing", async () => {
    const out: string[] = [];
    const code = await runCli(["jobs-about", "--dry"], { env: {}, jobsBackend: () => db, fetchImpl, out: (l) => out.push(l) });
    expect(code).toBe(0);
    expect(out.join("\n")).toMatch(/^jobs-about --dry: 8 companies; domains \+3/m);
    expect(db.seen.some((s) => s.startsWith("UPDATE"))).toBe(false);
  });
});
