// Парсери джерел проти СПРАВЖНІХ відповідей (fixtures/). Частина знята попереднім проєктом 13.09.2026
// (greenhouse-coinbase-pay, ashby-kraken-comp, lever-crypto-salary, speedrun-company-anchorage,
// getro-1625-page; перенесено з попереднього проєкту, сканер), решта знята 14.09.2026 з тих самих
// публічних адрес, що читає сканер, і обрізана до кількох вакансій (тексти скорочено).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetLimiters } from "../../limits.js";
import { prepare, WINDOWS } from "../prepare.js";
import type { BoardSource } from "../types.js";
import * as ats from "./ats.js";
import { fetchBoard, parseJobPostings, parseNextPayload, parseRssBoard, splitBoardTitle } from "./boards.js";
import { extractAts, fetchGetroLinks, orgIndustry } from "./getro.js";
import { fetchSpeedrunCompanyJobs, fetchSpeedrunCryptoCompanies, isRemoteRole, withAgentUtm, yearlyComp } from "./speedrun.js";
import { parseSuperteam } from "./superteam.js";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

/** fetch, що на будь-яку адресу віддає файл і запам'ятовує адреси. */
function serve(name: string | ((url: string) => string)) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    const file = typeof name === "string" ? name : name(String(url));
    return new Response(fixture(file), { status: 200, headers: { "content-type": file.endsWith(".json") ? "application/json" : "application/xml" } });
  }) as unknown as typeof fetch;
  return { urls, o: { fetchImpl, retries: 0 } };
}

const pay = (js: Array<{ salaryMin?: number | null; salaryMax?: number | null; salaryCurrency?: string | null }>) =>
  js.map((j) => [j.salaryMin ?? null, j.salaryMax ?? null, j.salaryCurrency ?? null]);

beforeEach(() => __resetLimiters());
afterEach(() => __resetLimiters());

describe("ATS: вилка з полів (попередній проєкт 13.09)", () => {
  it("Greenhouse з pay_transparency (Coinbase): річна, погодинна в річну, рупії", async () => {
    const { urls, o } = serve("greenhouse-coinbase-pay.json");
    const jobs = await ats.fetchGreenhouse("coinbase", "Coinbase", o);
    expect(urls[0]).toBe("https://boards-api.greenhouse.io/v1/boards/coinbase/jobs?content=false&pay_transparency=true");
    expect(pay(jobs)).toEqual([[166_345, 195_700, "USD"], [83_200, 83_200, "USD"], [2_755_300, 2_755_300, "INR"], [null, null, null]]);
    expect(jobs.every((j) => j.crypto && j.source === "greenhouse:coinbase")).toBe(true);
  });

  it("Ashby з includeCompensation (Kraken): Salary, без частки й бонусу; крапка в слагу", async () => {
    const { urls, o } = serve("ashby-kraken-comp.json");
    const jobs = await ats.fetchAshby("kraken.com", "Kraken", o);
    expect(urls[0]).toBe("https://api.ashbyhq.com/posting-api/job-board/kraken.com?includeCompensation=true");
    expect(pay(jobs)).toEqual([[175_800, 351_600, "USD"], [83_400, 166_800, "USD"], [null, null, null]]);
    expect(jobs[0]!.source).toBe("ashby:kraken.com");
  });

  it("Lever salaryRange (Crypto.com)", async () => {
    const { o } = serve("lever-crypto-salary.json");
    expect(pay(await ats.fetchLever("crypto", "Crypto.com", o))).toEqual([[70_000, 110_000, "USD"], [null, null, null]]);
  });

  it("Lever EU (Aave Labs): свій хост і вилка з поля", async () => {
    const { urls, o } = serve("lever-eu-aavelabs.json");
    const jobs = await ats.fetchLeverEu("aavelabs", "Aave Labs", o);
    expect(urls[0]).toBe("https://api.eu.lever.co/v0/postings/aavelabs?mode=json");
    expect(jobs.map((j) => [j.title, j.remote, j.source])).toEqual([
      ["Director, Capital Markets Growth", false, "lever_eu:aavelabs"],
      ["Dream Job", true, "lever_eu:aavelabs"],
      ["Head of Risk", false, "lever_eu:aavelabs"],
    ]);
    expect(pay(jobs)[0]).toEqual([180_000, 220_000, "USD"]);
  });
});

describe("ATS: форми відповідей, зняті 14.09", () => {
  it("Workable (Trail of Bits): адреса, дата, віддалено з telecommuting", async () => {
    const { urls, o } = serve("workable-trailofbits.json");
    const jobs = await ats.fetchWorkable("trailofbits", "Trail of Bits", o);
    expect(urls[0]).toBe("https://apply.workable.com/api/v1/widget/accounts/trailofbits?details=true");
    expect(jobs.map((j) => [j.title, j.url, j.remote, j.postedAt])).toEqual([
      ["Engineering Director, Application Security", "https://apply.workable.com/j/336A3CC4BC", true, "2026-08-27T00:00:00.000Z"],
      ["Senior Developer Relations Engineer", "https://apply.workable.com/j/427E4C8AA4", true, "2026-08-14T00:00:00.000Z"],
      ["Senior Security Engineer, Research & Engineering", "https://apply.workable.com/j/82AEBAB99A", true, "2026-09-02T00:00:00.000Z"],
    ]);
  });

  it("SmartRecruiters (Solflare): адреса з id, місто й країна", async () => {
    const { o } = serve("smartrecruiters-solflare.json");
    const [first] = await ats.fetchSmartRecruiters("solflare", "Solflare", o);
    expect(first).toMatchObject({ title: "Backend Developer", url: "https://jobs.smartrecruiters.com/solflare/744000138293725",
      location: "Novi Sad, rs", remote: true, source: "smartrecruiters:solflare", crypto: true });
  });

  it("Recruitee (Tether): лише опубліковані, адреса кар'єрного сайту, опис без HTML", async () => {
    const { urls, o } = serve("recruitee-tether.json");
    const jobs = await ats.fetchRecruitee("tether", "Tether", o);
    expect(urls[0]).toBe("https://tether.recruitee.com/api/offers/");
    expect(jobs.map((j) => [j.title, j.url, j.remote])).toEqual([
      ["Technical Lead - GPU Infrastructure (100% Remote - Worldwide)", "https://careers.tether.io/o/technical-lead-gpu-infrastructure-worldwide", true],
      ["USAT Institutional Associate", "https://careers.tether.io/o/usat-institutional-associate-5", true],
    ]);
    expect(jobs[0]!.description).not.toMatch(/<[a-z]/i);
  });

  it("Teamtailor (Crossmint): хост з регіоном, міста з tt:location, вилка з тексту через prepare", async () => {
    const { urls, o } = serve("teamtailor-crossmint.rss");
    const jobs = await ats.fetchTeamtailor("crossmint.na", "Crossmint", o);
    expect(urls[0]).toBe("https://crossmint.na.teamtailor.com/jobs.rss");
    expect(jobs.map((j) => [j.title, j.location, j.remote, j.source])).toEqual([
      ["Anti-Fraud Engineer (NYC / MIA)", null, false, "teamtailor:crossmint.na"],
      ["Engineering Manager - Identity, Compliance & Risk (NYC / MIA)", "New York, Miami", false, "teamtailor:crossmint.na"],
    ]);
    const { rows } = prepare(jobs, WINDOWS, new Date("2026-09-14T08:00:00Z"));
    expect(rows.map((r) => [r.title.slice(0, 16), r.salaryMin, r.salaryMax, r.salaryCurrency]).sort()).toEqual([
      ["Anti-Fraud Engin", 185_000, 220_000, "USD"], ["Engineering Mana", 250_000, 280_000, "USD"],
    ]);
  });

  it("Teamtailor: слаг з трьох частин або з чужими символами не йде в хост", async () => {
    const { o } = serve("teamtailor-crossmint.rss");
    await expect(ats.fetchTeamtailor("a.b.c", "X", o)).rejects.toThrow(/slug/);
    await expect(ats.fetchTeamtailor("evil.com/x?", "X", o)).rejects.toThrow(/slug/);
  });

  it("Rippling (Halborn), BambooHR (Hexens), Breezy (Nexo), Personio (Safe Labs)", async () => {
    const r = await ats.fetchRippling("halborn", "Halborn", serve("rippling-halborn.json").o);
    expect(r.map((j) => [j.location, j.remote, j.postedAt])).toEqual([["Miami, FL", false, null], ["Remote, OR", true, null], ["Remote (United States)", true, null]]);
    const b = await ats.fetchBambooHr("hexens", "Hexens", serve("bamboohr-hexens.json").o);
    expect(b.map((j) => j.url)).toEqual(["https://hexens.bamboohr.com/careers/29", "https://hexens.bamboohr.com/careers/36", "https://hexens.bamboohr.com/careers/40"]);
    const z = await ats.fetchBreezy("nexo", "Nexo", serve("breezy-nexo.json").o);
    expect(z.map((j) => [j.location, j.remote])).toEqual([["United States", true], ["United States", true], ["Sofia, Bulgaria", false]]);
    const p = await ats.fetchPersonio("safe-labs", "Safe Labs", serve("personio-safe-labs.xml").o);
    expect(p).toEqual([expect.objectContaining({ title: "Engineering Manager Wallet", url: "https://safe-labs.jobs.personio.de/job/2676903",
      location: "Berlin, DE", postedAt: "2026-06-17T22:06:14.000Z", source: "personio:safe-labs" })]);
  });

  it("слаг, що став би чужим хостом, відкидається до запиту", async () => {
    const { urls, o } = serve("breezy-nexo.json");
    await expect(ats.fetchBreezy("evil.com/x?", "X", o)).rejects.toThrow(/slug/);
    await expect(ats.fetchGreenhouse("../admin", "X", o)).rejects.toThrow(/slug/);
    expect(urls).toHaveLength(0);
  });
});

const W3: BoardSource = { name: "board:web3career", label: "Web3.career", kind: "jsonld", feedUrl: "https://web3.career/", cryptoOnly: true };
/** Дошка з розміткою JobPosting. Знімок сторінки web3.career тут лише зразок розмітки: сам web3.career читається через API. */
const LD: BoardSource = { name: "board:ld-example", label: "LD", kind: "jsonld", feedUrl: "https://jobs.example/", cryptoOnly: true };
/** Знімок дошки на Next.js. Саму jobstash.xyz сканер з 17.09.2026 не читає (BLOCKED_BOARDS); знімок лишився зразком формату. */
const JS: BoardSource = { name: "board:jobstash", label: "JobStash", kind: "nextjs", feedUrl: "https://jobstash.xyz/", cryptoOnly: false };
const R3: BoardSource = { name: "board:remote3", label: "Remote3", kind: "rss", feedUrl: "https://www.remote3.co/api/rss", cryptoOnly: true };

describe("дошки", () => {
  it("web3.career сторінками не читається: лише офіційний API, жодного запиту до сайту", async () => {
    const { urls, o } = serve("web3career-list.html");
    await expect(fetchBoard(W3, 30, o)).rejects.toThrow(/офіційний API/);
    await expect(fetchBoard({ ...LD, feedUrl: "https://www.web3.career/remote-jobs" }, 30, o)).rejects.toThrow(/офіційний API/);
    expect(urls).toHaveLength(0);
  });

  it("jobstash.xyz закрито 17.09.2026 на прохання власника дошки: жодного запиту, хоч би що в реєстрі", async () => {
    const { urls, o } = serve("web3career-list.html"); // до файлу не дійде: запиту немає
    await expect(fetchBoard(JS, 30, o)).rejects.toThrow(/jobstash\.xyz/);
    await expect(fetchBoard({ ...LD, feedUrl: "https://www.jobstash.xyz/jobs" }, 30, o)).rejects.toThrow(/jobstash\.xyz/);
    expect(urls).toHaveLength(0);
  });

  it("розмітка JobPosting: у списку без адрес, зшивається з посиланнями за слагом", async () => {
    const html = fixture("web3career-list.html");
    expect(parseJobPostings(html, LD)).toHaveLength(0); // адрес у розмітці списку немає
    const { urls, o } = serve("web3career-list.html");
    const jobs = await fetchBoard(LD, 30, o);
    // Друга сторінка (та сама відповідь) нічого нового не дала: гортання спинилось.
    expect(urls).toEqual(["https://jobs.example/", "https://jobs.example/?page=2"]);
    expect(jobs.length).toBeGreaterThanOrEqual(4);
    expect(jobs[0]).toMatchObject({
      url: "https://jobs.example/senior-principal-investigator-crypto-asset-investigations-tokenized-securities-markets-finra/154107",
      company: "FINRA", location: "Philadelphia, United States", remote: false, salaryMin: 150_000, salaryMax: 300_000,
      salaryCurrency: "USD", source: "board:ld-example", crypto: true,
    });
    expect(jobs.every((j) => j.url.startsWith("https://jobs.example/") && !j.url.includes("invalid"))).toBe(true);
  });

  it("remote3: «Роль at Компанія», компанія двічі, місце й вилка з опису", () => {
    const jobs = parseRssBoard(fixture("remote3.rss"), R3);
    expect(jobs).toHaveLength(8);
    expect(jobs[0]).toMatchObject({ company: "Ihsan", title: "Founding Senior Payments Platform Engineer \u2014 Stablecoin Neobank",
      location: null, remote: true, salaryMin: 120_000, salaryMax: 240_000, salaryCurrency: "USD" });
    expect(jobs[1]).toMatchObject({ company: "Bybit", title: "Lead Security Management Engineer" });
    expect(jobs.find((j) => j.location === "Kuala Lumpur")?.title).toBe("Principal Security Development Engineer");
  });

  it("splitBoardTitle", () => {
    expect(splitBoardTitle("Job Application for MLRO at Bybit at Bybit")).toEqual({ company: "Bybit", title: "MLRO" });
    expect(splitBoardTitle("Acme: Solidity Engineer")).toEqual({ company: "Acme", title: "Solidity Engineer" });
    expect(splitBoardTitle("no company here")).toBeNull();
  });

  it("JobStash: крипто лише за словом дошки; сторінка без потоку дає порожньо, а не помилку", () => {
    const org = (summary: string) => ({ name: "X", summary });
    const push = (o: object) => `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(o))}])</script>`;
    const html = push({ title: "Backend Engineer", href: "/jobs/1/backend", organization: org("operates crypto and stablecoin payment rails"), datePosted: "2026-09-10" })
      + push({ title: "Quant Researcher", href: "/jobs/2/quant", organization: org("proprietary trading firm") });
    const jobs = parseNextPayload(html, JS);
    expect(jobs.map((j) => [j.url, j.crypto])).toEqual([["https://jobstash.xyz/jobs/1/backend", true], ["https://jobstash.xyz/jobs/2/quant", false]]);
    // 14.09 головна JobStash віддавала лише каркас (їхній бекенд відповідав 503): тоді 0 вакансій.
    expect(parseNextPayload("<html><body>skeleton</body></html>", JS)).toEqual([]);
  });
});

describe("speedrun", () => {
  it("крипто-компанії: галузь «Crypto/Web3» у списку плюс колекція crypto-web3", async () => {
    const { urls, o } = serve((u) => (u.includes("/collections/") ? "speedrun-collection-crypto.json" : "speedrun-companies-page.json"));
    const companies = await fetchSpeedrunCryptoCompanies(o);
    expect([...companies.keys()]).toEqual(["anchorage", "alchemy", "talos", "morpho-labs"]);
    expect(urls.every((u) => u.includes("source=nextcryptojob"))).toBe(true);
  });

  it("ролі компанії (Anchorage) з нашою атрибуцією й вікном", async () => {
    const { o } = serve("speedrun-company-anchorage.json");
    const jobs = await fetchSpeedrunCompanyJobs("anchorage", "Anchorage", 400, o);
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({ company: "Anchorage", source: "aggregator:speedrun", crypto: true });
    expect(jobs[0]!.url).toBe("https://speedrun-talent-network.com/jobs/member-of-legal-brokerage-and-trading-solutions-anchorage-efe55693?utm_source=nextcryptojob&utm_medium=agent");
    const days = (Date.now() - Date.parse("2026-08-05T00:00:00Z")) / 86_400_000;
    expect((await fetchSpeedrunCompanyJobs("anchorage", "Anchorage", days, serve("speedrun-company-anchorage.json").o)).map((j) => j.title))
      .toEqual(["Member of Legal, Brokerage and Trading Solutions"]);
  });

  it("період і місце роботи (перенесено з попереднього проєкту)", () => {
    expect(yearlyComp(165_000, null)).toBe(165_000);
    expect(yearlyComp(24, "hour")).toBe(49_920);
    expect(yearlyComp(10, null)).toBeNull();
    expect(isRemoteRole({ remote: true, workplace_type: "OnSite" })).toBe(false);
    expect(isRemoteRole({ remote: true, workplace_type: null })).toBe(true);
    const u = "https://speedrun-talent-network.com/jobs/x-1?utm_source=other&utm_medium=agent";
    expect(withAgentUtm(u)).toBe(u);
  });
});

describe("Superteam Earn", () => {
  it("відкриті баунті й проєкти, без вилки, адреса сторінки завдання", () => {
    const jobs = parseSuperteam(JSON.parse(fixture("superteam-listings.json")), new Date("2026-09-14T08:00:00Z"));
    expect(jobs.map((j) => [j.title, j.company, j.url])).toEqual([
      ["Bounty: NectarFi x Dominion Market", "NectarFi", "https://superteam.fun/earn/listing/nectarfi-x-dominion-market"],
      ["Bounty: X Post About Grow App", "Grow", "https://superteam.fun/earn/listing/x-post-about-grow-app"],
      ["Bounty: Try out new docs to build a trusted agent with T3N that we can distribute / host", "Terminal 3 Network", "https://superteam.fun/earn/listing/t3n-agent-build-challenge"],
      ["Project: Trading Content Partner for KriptoK League | 2-Month Project", "KriptoK", "https://superteam.fun/earn/listing/kriptok-league-trading-content-partner"],
    ]);
    expect(jobs.every((j) => j.salaryMin === undefined && j.crypto)).toBe(true);
  });

  it("строк минув: не береться", () => {
    const jobs = parseSuperteam(JSON.parse(fixture("superteam-listings.json")), new Date("2026-09-15T00:00:00Z"));
    expect(jobs.map((j) => j.company)).not.toContain("NectarFi");
  });
});

describe("Getro: лише посилання для розвідки (колекція Coinbase Ventures, попередній проєкт 13.09)", () => {
  it("галузь організації за словами Getro і ATS з посилання", async () => {
    const links = await fetchGetroLinks(1625, serve("getro-1625-page.json").o, 1, 0);
    expect(links.map((l) => [l.company, l.industry, extractAts(l.url)])).toEqual([
      ["Tactic", "crypto", { provider: "greenhouse", slug: "taxbit" }],
      ["BVNK", "crypto", { provider: "greenhouse", slug: "bvnk" }],
      ["VALR", "crypto", { provider: "hibob", slug: "valr" }], // з 17.09 HiBob читаємо
      ["Notion", "other", { provider: "ashby", slug: "notion" }],
    ]);
    expect(orgIndustry(undefined)).toBe("unknown");
  });

  it("extractAts: крапка й %20 у слагу Ashby, вбудована форма Greenhouse, Recruitee, Teamtailor з регіоном", () => {
    expect(extractAts("https://jobs.ashbyhq.com/kraken.com/0b9a1b2c")).toEqual({ provider: "ashby", slug: "kraken.com" });
    expect(extractAts("https://jobs.ashbyhq.com/Sui%20Foundation/1")).toEqual({ provider: "ashby", slug: "Sui%20Foundation" });
    expect(extractAts("https://boards.greenhouse.io/embed/job_app?for=coinbase&token=1")).toEqual({ provider: "greenhouse", slug: "coinbase" });
    expect(extractAts("https://acme.recruitee.com/o/senior-engineer")).toEqual({ provider: "recruitee", slug: "acme" });
    expect(extractAts("https://jobs.eu.lever.co/aavelabs/1")).toEqual({ provider: "lever_eu", slug: "aavelabs" });
    expect(extractAts("https://crossmint.na.teamtailor.com/jobs/697262-anti-fraud")).toEqual({ provider: "teamtailor", slug: "crossmint.na" });
    expect(extractAts("https://valr.careers.hibob.com/jobs/1")).toEqual({ provider: "hibob", slug: "valr" });
    expect(extractAts("https://jobs.gem.com/trojan-trading/am9icG9zdDrT7W4v")).toEqual({ provider: "gem", slug: "trojan-trading" });
    expect(extractAts("https://zinc.pinpointhq.com/en/postings/a654df0a")).toEqual({ provider: "pinpoint", slug: "zinc" });
    // Workday: мовний префікс пропускаємо, регістр назви сайту лишаємо; службова адреса cxs не дошка.
    expect(extractAts("https://bullish.wd3.myworkdayjobs.com/en-US/Bullish/job/New-York/Director_JR1")).toEqual({ provider: "workday", slug: "bullish.wd3.Bullish" });
    expect(extractAts("https://Bullish.wd3.myworkdayjobs.com/Bullish")).toEqual({ provider: "workday", slug: "bullish.wd3.Bullish" });
    expect(extractAts("https://bullish.wd3.myworkdayjobs.com/wday/cxs/bullish/Bullish/jobs")).toBeNull();
    // Comeet лише руками: у посиланні немає токена.
    expect(extractAts("https://www.comeet.com/jobs/blockaid/69.00B/backend-engineer/F2.C56")).toBeNull();
  });
});

/** fetch з готовою відповіддю: для вилок, яких немає в знятих файлах. */
function answer(body: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, o: { fetchImpl, retries: 0 } };
}

describe("ATS, додані 17.09 (форми зняті 17.09 з публічних адрес)", () => {
  it("Gem (Trojan Trading): адреса API, remote з location_type, дата першої публікації", async () => {
    const { urls, o } = serve("gem-trojan-trading.json");
    const jobs = await ats.fetchGem("trojan-trading", "Trojan", o);
    expect(urls[0]).toBe("https://api.gem.com/job_board/v0/trojan-trading/job_posts/");
    expect(jobs).toHaveLength(3);
    expect(jobs[0]).toMatchObject({ title: "Technical Project Manager", location: "France - Remote", remote: true,
      url: "https://jobs.gem.com/trojan-trading/am9icG9zdDrT7W4vSkgg-QQ4p2UNQRBe",
      postedAt: "2025-06-12T14:58:22.887Z", source: "gem:trojan-trading", crypto: true });
  });

  it("Pinpoint (Zinc): postings.json, без дати, onsite не remote", async () => {
    const { urls, o } = serve("pinpoint-zinc.json");
    const jobs = await ats.fetchPinpoint("zinc", "Zinc", o);
    expect(urls[0]).toBe("https://zinc.pinpointhq.com/postings.json");
    expect(jobs.map((j) => [j.title, j.location, j.remote, j.postedAt])).toEqual([
      ["Head of DEI - Belfast", "Belfast", false, null], ["Head of DEI - US", "Washington", false, null], ["Head of DEI - UK", "London", false, null]]);
    expect(jobs[0]!.source).toBe("pinpoint:zinc");
    expect(pay(jobs)).toEqual([[null, null, null], [null, null, null], [null, null, null]]);
  });

  it("Pinpoint: місячна вилка стає річною; прихована не пишеться", async () => {
    const row = { title: "Engineer", url: "https://acme.pinpointhq.com/en/postings/1", location: { name: "London" }, workplace_type: "remote",
      compensation_minimum: 5000, compensation_maximum: 6000, compensation_currency: "gbp", compensation_frequency: "month" };
    const { o } = answer({ data: [row, { ...row, compensation_visible: false }] });
    const jobs = await ats.fetchPinpoint("acme", "Acme", o);
    expect(pay(jobs)).toEqual([[60_000, 72_000, "GBP"], [null, null, null]]);
    expect(jobs[0]!.remote).toBe(true);
  });

  it("HiBob (VALR): заголовок companyidentifier, адреса вакансії з id, місце без повтору", async () => {
    const { urls, o } = serve("hibob-valr.json");
    const jobs = await ats.fetchHiBob("valr", "VALR", o);
    expect(urls[0]).toBe("https://valr.careers.hibob.com/api/job-ad");
    expect(jobs[0]).toMatchObject({ title: "Senior Infrastructure Engineer", location: "South Africa", remote: true,
      url: "https://valr.careers.hibob.com/jobs/fc23ce11-483c-44cf-bd5f-5f66304116bb",
      postedAt: "2026-09-11T13:59:24.724Z", source: "hibob:valr" });
    expect(jobs[1]!.location).toBe("Nigeria");
    const { calls, o: o2 } = answer({ jobAdDetails: [{ id: "a", title: "PM", site: "Cape-Town", country: "South Africa",
      payTransparencyMinSalary: 900_000, payTransparencyMaxSalary: 1_200_000, payTransparencySalaryCurrency: "ZAR",
      payTransparencySalaryPayPeriod: "Annual" }] });
    const [pm] = await ats.fetchHiBob("valr", "VALR", o2);
    expect(new Headers(calls[0]!.init?.headers).get("companyidentifier")).toBe("valr");
    expect(pm).toMatchObject({ location: "Cape Town, South Africa", salaryMin: 900_000, salaryMax: 1_200_000, salaryCurrency: "ZAR" });
  });

  it("Comeet (Blockaid): uid і токен зі слага, токен не йде в ключ джерела", async () => {
    const slug = "69.00B.96B41ED041ED12D654C3388241ED12D654C3";
    const { urls, o } = serve("comeet-blockaid.json");
    const jobs = await ats.fetchComeet(slug, "Blockaid", o);
    expect(urls[0]).toBe("https://www.comeet.co/careers-api/2.0/company/69.00B/positions?token=96B41ED041ED12D654C3388241ED12D654C3&details=false");
    expect(jobs[1]).toMatchObject({ title: "Backend Engineer", location: "Tel Aviv-Yafo, IL", remote: false,
      url: "https://www.comeet.com/jobs/blockaid/69.00B/backend-engineer/F2.C56", source: "comeet:69.00B" });
    expect(ats.atsSourceKey("comeet", slug)).toBe("comeet:69.00B");
    expect(() => ats.comeetSlug("69.00B")).toThrow();
    expect(() => ats.comeetSlug("evil.com/x.ABCDEF0123456789")).toThrow();
  });

  it("Workday (Bullish): POST cxs, адреса з externalPath, дата зі слів, «30+» без дати", async () => {
    const { urls, o } = serve("workday-bullish.json");
    const jobs = await ats.fetchWorkday("bullish.wd3.Bullish", "Bullish", o);
    expect(urls[0]).toBe("https://bullish.wd3.myworkdayjobs.com/wday/cxs/bullish/Bullish/jobs");
    expect(jobs[0]).toMatchObject({ title: "Director, Exchange Sales", location: "New York",
      url: "https://bullish.wd3.myworkdayjobs.com/Bullish/job/New-York/Director--Exchange-Sales_JR2001274-1",
      source: "workday:bullish.wd3.Bullish" });
    expect(jobs.at(-1)!.postedAt).toBeNull();
    expect(ats.atsSourceKey("workday", "bullish.wd3.Bullish")).toBe("workday:bullish.wd3.Bullish");
    const now = new Date("2026-09-17T12:00:00Z");
    expect(ats.workdayPosted("Posted Today", now)).toBe("2026-09-17T12:00:00.000Z");
    expect(ats.workdayPosted("Posted Yesterday", now)).toBe("2026-09-16T12:00:00.000Z");
    expect(ats.workdayPosted("Posted 3 Days Ago", now)).toBe("2026-09-14T12:00:00.000Z");
    expect(ats.workdayPosted("Posted 30+ Days Ago", now)).toBeNull();
    expect(() => ats.workdaySlug("evil.com/x.wd3.site")).toThrow();
  });

  it("Workday гортає сторінки по 20, поки сторінка повна", async () => {
    const page = (n: number) => ({ jobPostings: Array.from({ length: n }, (_, i) => ({ title: `Role ${i}`, externalPath: `/job/x_${i}`, locationsText: "2 Locations", postedOn: "Posted Today" })) });
    const bodies = [page(20), page(5)];
    const offsets: number[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      offsets.push(JSON.parse(String(init?.body)).offset);
      return new Response(JSON.stringify(bodies.shift()), { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const jobs = await ats.fetchWorkday("acme.wd1.External", "Acme", { fetchImpl, retries: 0 });
    expect(offsets).toEqual([0, 20]);
    expect(jobs).toHaveLength(25);
    expect(jobs[0]!.location).toBeNull();
  });

  it("реєстр ATS знає всі п'ять", () => {
    for (const p of ["gem", "pinpoint", "hibob", "comeet", "workday"] as const) expect(typeof ats.ATS[p]).toBe("function");
  });
});
