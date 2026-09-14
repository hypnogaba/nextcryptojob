// Розвідка з дошок екосистем: куди веде посилання вакансії і як сторінка кар'єри роботодавця видає
// його ATS. Знімки: сторінка jobs.solana.com (Getro 858, 14.09.2026: лише організації й адреси, без
// назв і текстів вакансій), сторінки кар'єри anchorage.com і fireblocks.com (14.09.2026, обрізані до
// місць з адресами ATS).
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetLimiters } from "../../limits.js";
import { bestAts, groupOrgs, inScope } from "../discover.js";
import { atsFromHtml, atsHintFromUrl, careerLinks, resolveCareerPage, resolveCompanySite } from "./careers.js";
import { classifyLink, extractAts, fetchGetroLinks, isGetroHosted } from "./getro.js";

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

function serve(route: (url: string) => { status: number; body: string }) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    const r = route(String(url));
    return new Response(r.body, { status: r.status, headers: { "content-type": "text/html" } });
  }) as unknown as typeof fetch;
  return { urls, o: { fetchImpl, retries: 0, lookup: null } };
}

beforeEach(() => __resetLimiters());
afterEach(() => __resetLimiters());

describe("Getro: куди ведуть вакансії дошки (jobs.solana.com, сторінка 0)", () => {
  it("організація, id і «лише на Getro» з самої відповіді", async () => {
    const { o } = serve(() => ({ status: 200, body: fixture("getro-858-page.json") }));
    const links = await fetchGetroLinks(858, o, 1, 0, "jobs.solana.com");
    expect(links).toHaveLength(14);
    const arcade = links.find((l) => l.company === "Arcade")!;
    expect(arcade).toMatchObject({ hosted: true, industry: "crypto" });
    expect(links.filter((l) => l.hosted)).toHaveLength(1);
    expect(links.find((l) => l.company === "Phantom")).toMatchObject({ industry: "other", hosted: false, orgId: 35393 });
  });

  it("класифікація: ATS, який скан читає; сама дошка; інший ATS; сторінка роботодавця", () => {
    expect(classifyLink({ url: "https://jobs.ashbyhq.com/phantom/d1c4", hosted: false })).toEqual({ kind: "ats", provider: "ashby", slug: "phantom" });
    expect(classifyLink({ url: "https://ats.rippling.com/perle/jobs/1", hosted: false })).toEqual({ kind: "ats", provider: "rippling", slug: "perle" });
    expect(classifyLink({ url: "https://jobs.solana.com/companies/arcade-2/jobs/1", hosted: true })).toEqual({ kind: "hosted" });
    expect(classifyLink({ url: "https://app.screenloop.com/careers/avianlabs/job_posts/8866", hosted: false })).toEqual({ kind: "other-ats", name: "screenloop" });
    expect(classifyLink({ url: "https://acme.wd1.myworkdayjobs.com/en-US/careers/job/1", hosted: false })).toEqual({ kind: "other-ats", name: "workday" });
    expect(classifyLink({ url: "https://www.anchorage.com/careers?gh_jid=1", hosted: false })).toEqual({ kind: "career-page", host: "anchorage.com" });
    expect(isGetroHosted("https://x.getro.com/companies/a/jobs/1", "career_page")).toBe(true);
    expect(isGetroHosted("https://jobs.solana.com/companies/a/jobs/1", "career_page", "jobs.solana.com")).toBe(true);
    expect(isGetroHosted("https://jobs.lever.co/a/1", "admin_portal")).toBe(true);
    expect(isGetroHosted("https://jobs.lever.co/a/1", "career_page", "jobs.solana.com")).toBe(false);
  });

  it("організації дошки: найчастіша дошка ATS, «лише Getro», інший ATS; крипто за crypto_scope", async () => {
    const { o } = serve(() => ({ status: 200, body: fixture("getro-858-page.json") }));
    const orgs = groupOrgs(await fetchGetroLinks(858, o, 1, 0, "jobs.solana.com"));
    const by = new Map(orgs.map((x) => [x.company, x]));
    expect(orgs).toHaveLength(12); // 14 вакансій, Baton тричі
    expect(by.get("Baton Corporation")).toMatchObject({ jobs: 3 });
    expect(bestAts(by.get("Baton Corporation")!)).toEqual({ provider: "ashby", slug: "batoncorporation" });
    expect(bestAts(by.get("Douro Labs")!)).toEqual({ provider: "ashby", slug: "dourolabs.xyz" });
    expect(bestAts(by.get("Crossmint")!)).toEqual({ provider: "teamtailor", slug: "crossmint.na" });
    expect(by.get("Arcade")).toMatchObject({ hosted: 1, careerUrls: [] });
    expect([...by.get("Morse")!.otherAts.keys()]).toEqual(["screenloop"]);
    // Екосистема: кожна організація крипто; фонд з 'tagged': лише ті, кого Getro так і називає, або без галузі.
    expect(inScope(by.get("Phantom")!, "all")).toBe(true);
    expect(inScope(by.get("Phantom")!, "tagged")).toBe(false);
    expect(inScope(by.get("Baton Corporation")!, "tagged")).toBe(true);
    // Ігровий фонд ('strict'): лише ті, кого Getro так і називає крипто.
    expect(inScope(by.get("Baton Corporation")!, "strict")).toBe(false);
    expect(inScope(by.get("Fomo")!, "strict")).toBe(true);
  });
});

describe("сторінка кар'єри роботодавця → ATS", () => {
  it("посилання на дошку ATS (anchorage.com → Lever) і скрипт вбудовування (fireblocks.com → Greenhouse)", () => {
    expect(atsFromHtml(fixture("careers-anchorage.html"))).toEqual({ provider: "lever", slug: "anchorage" });
    expect(atsFromHtml(fixture("careers-fireblocks.html"))).toEqual({ provider: "greenhouse", slug: "fireblocks" });
  });

  it("найчастіша дошка перемагає випадкову; службові адреси ATS не слаг; без ATS null", () => {
    const html = `<a href="https://jobs.ashbyhq.com/acme/1">a</a><a href="https://jobs.ashbyhq.com/acme/2">b</a>
      <a href="https://boards.greenhouse.io/partner">partner</a><script src="https://jobs.ashbyhq.com/embed/x.js"></script>
      <script src="https://job-boards.greenhouse.io/embed/job_board/js?for=acme&amp;b=1"></script>`;
    expect(atsFromHtml(html)).toEqual({ provider: "ashby", slug: "acme" });
    expect(atsFromHtml('<a href="https://acme.xyz/careers">Careers</a>')).toBeNull();
    expect(extractAts("https://jobs.ashbyhq.com/embed")).toBeNull();
    expect(extractAts("https://boards-api.greenhouse.io/v1/boards/acme/jobs")).toEqual({ provider: "greenhouse", slug: "acme" });
    expect(extractAts("https://acme.bamboohr.com/jobs/view.php?id=1")).toEqual({ provider: "bamboohr", slug: "acme" });
    expect(extractAts("https://careers.smartrecruiters.com/Acme1")).toEqual({ provider: "smartrecruiters", slug: "acme1" });
    expect(extractAts("https://io-global.workable.com/jobs/6079614")).toEqual({ provider: "workable", slug: "io-global" });
    expect(extractAts("https://www.workable.com/pricing")).toBeNull();
  });

  it("параметр адреси каже провайдера без слага", () => {
    expect(atsHintFromUrl("https://www.anchorage.com/careers?gh_jid=4401466009")).toBe("greenhouse");
    expect(atsHintFromUrl("https://acme.xyz/careers?ashby_jid=abc")).toBe("ashby");
    expect(atsHintFromUrl("https://acme.xyz/careers")).toBeNull();
  });

  it("сторінка вакансії без ATS, тоді /careers того ж сайту; не більше двох сторінок", async () => {
    const s = serve((u) => u.endsWith("/careers")
      ? { status: 200, body: fixture("careers-anchorage.html") }
      : { status: 200, body: "<html><body>Open role</body></html>" });
    await expect(resolveCareerPage("https://www.anchorage.com/careers/role-1?gh_jid=1", s.o))
      .resolves.toEqual({ hit: { provider: "lever", slug: "anchorage" }, from: "https://www.anchorage.com/careers" });
    expect(s.urls).toEqual(["https://www.anchorage.com/careers/role-1?gh_jid=1", "https://www.anchorage.com/careers"]);
    const none = serve(() => ({ status: 404, body: "no" }));
    await expect(resolveCareerPage("https://acme.xyz/jobs/1", none.o)).resolves.toBeNull();
    expect(none.urls).toHaveLength(2);
  });

  it("сайт компанії з портфеля: посилання «кар'єра» з головної, лише свій домен", async () => {
    const home = `<a href="/about">About</a><a href="https://careers.acme.xyz/">Join us</a><a href="https://evil.example/jobs">Jobs</a>
      <a href="/company/careers">Careers</a>`;
    expect(careerLinks(home, "https://www.acme.xyz/")).toEqual(["https://careers.acme.xyz/", "https://www.acme.xyz/company/careers"]);
    const s = serve((u) => u === "https://www.acme.xyz/" ? { status: 200, body: home }
      : u === "https://www.acme.xyz/company/careers" ? { status: 200, body: fixture("careers-fireblocks.html") }
      : { status: 200, body: "<html></html>" });
    await expect(resolveCompanySite("https://www.acme.xyz/", s.o))
      .resolves.toEqual({ hit: { provider: "greenhouse", slug: "fireblocks" }, from: "https://www.acme.xyz/company/careers" });
    expect(s.urls.some((u) => u.includes("evil.example"))).toBe(false);
  });
});
