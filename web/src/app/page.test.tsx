import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { resetHomeBoard } from "@/lib/jobs/home-board";
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
  resetHomeBoard();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  harness.env.DB = crmDb().d1;
  const nr = nextroleJobsDb();
  const f = hoursAgo(3);
  addPoolJob(nr.raw, { id: "a", title: "Protocol Engineer", company: "Aave", postedAt: hoursAgo(20), fetchedAt: f, salaryMin: 140_000, salaryMax: 170_000, currency: "USD" });
  addPoolJob(nr.raw, { id: "b", title: "Growth Marketing Lead", company: "Phantom", postedAt: hoursAgo(30), fetchedAt: f, source: "ashby:phantom" });
  addPoolJob(nr.raw, { id: "c", title: "Crypto Trader", company: "Wintermute", postedAt: hoursAgo(24 * 9), fetchedAt: f, source: "aggregator:remoteok" });
  // Ще 9 компаній із зарплатою: разом 10 у стрічці, досить, щоб вона їхала по колу.
  for (let i = 1; i <= 9; i++) {
    addPoolJob(nr.raw, { id: `p${i}`, title: `Solidity Engineer ${i}`, company: `Chain ${i}`, postedAt: hoursAgo(40 + i), fetchedAt: f, salaryMin: 100_000 + i * 1000, currency: "USD" });
  }
  jobsHolder.open = () => readOnlyJobsDb(nr.d1);
});
afterEach(() => vi.restoreAllMocks());

const home = async () => renderToStaticMarkup(await HomePage());

/** Текст сторінки без тегів: так його бачить людина (цифри лічильника в окремих span). */
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

describe("home page", () => {
  it("leads with one job: get a job seeker to the brief, with the card as the hook", async () => {
    const html = await home();
    expect(html).toContain("Crypto jobs that fit you.");
    expect(html).toMatch(/<a[^>]*href="\/login"[^>]*>Get my jobs<\/a>/);
    expect(html).toContain("Free. About 2 minutes. Jobs by Telegram or email.");
    // Картка-приклад з EXAMPLE, зворот з розкладом, підпис про те, що людина отримає.
    expect(html).toContain("ncj-tag-example");
    expect(html).toContain("Example card.");
    expect(html).toContain("See how the score adds up");
    expect(html).toContain("What you get: a 0 to 100 score for your role, and jobs for that role every day.");
    expect(html).toContain("How it works");
    expect(html).toContain("Tell us what you want");
    expect(html).toContain("We match you");
    expect(html).toContain("Get a few jobs every day");
    expect(html).toContain("What&#x27;s on your card");
    expect(html).toContain('href="/scoring"');
    expect(html).toContain('href="/company"');
    expect(html).toContain('href="/agents"');
  });

  it("puts the real counts in the server HTML, rounded down", async () => {
    const t = text(await home());
    // 12 рядків, 12 компаній; Wintermute опублікована 9 днів тому, тож нових 11; із зарплатою Aave і 9 Chain.
    expect(t).toContain("Live crypto jobs12");
    expect(t).toContain("New this week11");
    expect(t).toContain("Companies hiring12");
    expect(t).toContain("With salary listed10");
    expect(t).toContain("From 3 job sources. Updated 3 h ago.");
  });

  it("rolls each digit from zero with CSS, and keeps the real digit as the text", async () => {
    const html = await home();
    // «12»: десятки роблять оберт і стають на 1 (11 рядків), одиниці два оберти й 2 (22 рядки).
    expect(html).toContain('<span class="ncj-odo-col" style="--rows:11;--seq:&quot;0\\A 1\\A 2');
    expect(html).toMatch(/--rows:22;--seq:&quot;0\\A [^"]*9\\A 0\\A 1&quot;">2<\/span>/);
  });

  it("runs a ticker of live jobs with a salary, one per company, listed once for screen readers", async () => {
    const html = await home();
    const t = text(html);
    expect(t).toContain("Protocol Engineer");
    expect(html).toContain('aria-label="Protocol Engineer, Aave, Remote, $140k to $170k"');
    expect(html).toContain('href="https://boards.example.com/a" target="_blank" rel="noopener noreferrer nofollow"');
    // Без зарплати в стрічку не йде.
    expect(html).not.toContain("Growth Marketing Lead");
    expect(html).toContain('data-moving="true"');
    const lists = html.match(/<ul class="ncj-ticker-list"[^>]*>/g) ?? [];
    expect(lists).toHaveLength(2);
    expect(lists[0]).toContain('aria-label="Live jobs with a salary"');
    expect(lists[1]).toContain('aria-hidden="true"');
    // Копія не ловить фокус з клавіатури.
    const from = html.lastIndexOf('<ul class="ncj-ticker-list"');
    const copy = html.slice(from, html.indexOf("</ul>", from));
    expect(copy.match(/<a /g)?.length).toBe(10);
    expect(copy.match(/tabindex="-1"/g)?.length).toBe(10);
  });

  it("still renders when the jobs database fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    jobsHolder.open = () => ({ all: async () => Promise.reject(new Error("D1_ERROR: overloaded")), first: async () => null });
    const html = await home();
    expect(html).toContain("Crypto jobs that fit you.");
    expect(html).toContain("Live job counts did not load just now.");
    expect(html).not.toContain("Live crypto jobs");
    expect(html).not.toContain("ncj-ticker");
    expect(html).toMatch(/href="\/login"/);
  });

  it("still renders when the Worker has no jobs database binding", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    jobsHolder.open = () => {
      throw new Error("JOBS_DB is not bound");
    };
    const html = await home();
    expect(html).toContain("Live job counts did not load just now.");
  });

  it("keeps the scouting board, x402 and the scoring details off the home page", async () => {
    const html = await home();
    for (const gone of ["Ten positions", "Scouting board", "x402", "Rated on what you shipped", "Post your card"]) {
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
