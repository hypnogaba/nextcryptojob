import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { resetTodayJobs } from "@/lib/jobs/instant";
import { resetNextrolePool } from "@/lib/jobs/nextrole-pool";
import { crmDb } from "@/test/crm-fixtures";
import { harness, resetHarness } from "@/test/harness";
import { addPoolJob, nextroleJobsDb } from "@/test/nextrole-jobs-db";
import AgentsPage from "./agents/page";
import CompanyLandingPage from "./company/page";
import HomePage from "./page";
import ScoringPage from "./scoring/page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);

// База NextRole: прив'язку підміняємо на рівні модуля, як і в Worker лише через jobsDb().
const jobsHolder = vi.hoisted(() => ({ open: null as null | (() => JobsDb) }));
vi.mock("@/lib/jobs-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs-db")>()),
  jobsDb: () => jobsHolder.open!(),
}));

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

beforeEach(() => {
  resetHarness();
  resetNextrolePool();
  resetTodayJobs();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  harness.env.DB = crmDb().d1;
  const nr = nextroleJobsDb();
  const f = hoursAgo(3);
  addPoolJob(nr.raw, { id: "a", title: "Protocol Engineer", company: "Aave", postedAt: hoursAgo(20), fetchedAt: f, salaryMin: 140_000, salaryMax: 170_000, currency: "USD" });
  addPoolJob(nr.raw, { id: "b", title: "Growth Marketing Lead", company: "Phantom", postedAt: hoursAgo(30), fetchedAt: f, source: "ashby:phantom" });
  addPoolJob(nr.raw, { id: "c", title: "Crypto Trader", company: "Wintermute", postedAt: hoursAgo(10), fetchedAt: f, source: "aggregator:remoteok" });
  jobsHolder.open = () => readOnlyJobsDb(nr.d1);
});
afterEach(() => vi.restoreAllMocks());

const home = async () => renderToStaticMarkup(await HomePage());

describe("home page", () => {
  it("leads with one job: get a job seeker to the brief", async () => {
    const html = await home();
    expect(html).toContain("Crypto jobs that fit you.");
    expect(html).toMatch(/<a[^>]*href="\/login"[^>]*>Get my jobs<\/a>/);
    expect(html).toMatch(/<a[^>]*href="#today"[^>]*>See today&#x27;s jobs<\/a>/);
    expect(html).toContain("How it works");
    expect(html).toContain("Tell us what you want");
    expect(html).toContain("We match you");
    expect(html).toContain("Get a few jobs every day");
    expect(html).toContain('href="/scoring"');
    expect(html).toContain('href="/company"');
    expect(html).toContain('href="/agents"');
  });

  it("shows a real example list from the live pool and an honest count", async () => {
    const html = await home();
    expect(html).toContain('id="today"');
    expect(html).toContain("Example list");
    expect(html).toContain("Protocol Engineer");
    expect(html).toContain("Aave · Remote · $140k to $170k");
    expect(html).toContain('href="https://boards.example.com/a"');
    expect(html).toContain("Crypto Trader");
    expect(html).toContain("3 live crypto jobs from 3 sources, updated daily.");
  });

  it("still renders when the jobs database fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    jobsHolder.open = () => ({ all: async () => Promise.reject(new Error("D1_ERROR: overloaded")), first: async () => null });
    const html = await home();
    expect(html).toContain("Crypto jobs that fit you.");
    expect(html).toContain("Today&#x27;s jobs did not load just now.");
    expect(html).not.toContain("live crypto job");
    expect(html).toMatch(/href="\/login"/);
  });

  it("still renders when the Worker has no jobs database binding", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    jobsHolder.open = () => {
      throw new Error("JOBS_DB is not bound");
    };
    const html = await home();
    expect(html).toContain("Today&#x27;s jobs did not load just now.");
  });

  it("keeps scoring, the scouting board and x402 off the home page", async () => {
    const html = await home();
    for (const gone of ["Every ten points", "Ten positions", "Scouting board", "x402", "Rated on what you shipped", "Post your card"]) {
      expect(html).not.toContain(gone);
    }
  });
});

describe("pages that took the old home sections", () => {
  it("/scoring has the card, the finish ladder and the ten positions, and links to the formulas", () => {
    const html = renderToStaticMarkup(ScoringPage());
    expect(html).toContain("Rated on what you shipped.");
    expect(html).toContain("Every ten points adds a layer to your seal.");
    expect(html).toContain("Ten positions");
    expect(html).toContain("Post your card");
    expect(html).toContain('href="/how-scoring-works"');
  });

  it("/agents has REST, MCP and x402 with the OpenAPI file and the MCP endpoint", () => {
    const html = renderToStaticMarkup(AgentsPage());
    expect(html).toContain('href="/openapi.yaml"');
    expect(html).toContain("https://nextcryptojob.xyz/mcp");
    expect(html).toContain("/api/v1/public/jobs");
    expect(html).toContain("/api/v1/candidates/search");
    expect(html).toContain("x402");
  });

  it("/company has the scouting board", () => {
    const html = renderToStaticMarkup(CompanyLandingPage());
    expect(html).toContain("Scouting board");
    expect(html).toContain("#B21E90");
  });
});
