import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { resetHomeBoard } from "@/lib/jobs/home-board";
import { resetCrawlPool } from "@/lib/jobs/pool";
import { crmDb } from "@/test/crm-fixtures";
import { harness, resetHarness } from "@/test/harness";
import { addPoolJob, jobsTestDb } from "@/test/jobs-db";
import AgentsPage from "./agents/page";
import CompanyLandingPage from "./company/page";
import HomePage from "./page";
import ScoringPage from "./scoring/page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);

// База вакансій: прив'язку підміняємо на рівні модуля, як і в Worker лише через jobsDb().
const jobsHolder = vi.hoisted(() => ({ open: null as null | (() => JobsDb) }));
vi.mock("@/lib/jobs-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs-db")>()),
  jobsDb: () => jobsHolder.open!(),
}));

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

beforeEach(() => {
  resetHarness();
  resetCrawlPool();
  resetHomeBoard();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  harness.env.DB = crmDb().d1;
  const nr = jobsTestDb();
  const f = hoursAgo(3);
  addPoolJob(nr.raw, { id: "a", title: "Protocol Engineer", company: "Aave", postedAt: hoursAgo(20), fetchedAt: f, salaryMin: 140_000, salaryMax: 170_000, currency: "USD" });
  addPoolJob(nr.raw, { id: "b", title: "Growth Marketing Lead", company: "Phantom", postedAt: hoursAgo(30), fetchedAt: f, source: "ashby:phantom" });
  addPoolJob(nr.raw, { id: "c", title: "Crypto Trader", company: "Wintermute", postedAt: hoursAgo(24 * 9), fetchedAt: f, source: "aggregator:remoteok" });
  // Ще 12 компаній із зарплатою: Aave і Chain 1 до 4 ідуть у приклад листа, решта 8 у стрічку,
  // досить, щоб вона їхала по колу.
  for (let i = 1; i <= 12; i++) {
    addPoolJob(nr.raw, { id: `p${i}`, title: `Solidity Engineer ${i}`, company: `Chain ${i}`, postedAt: hoursAgo(40 + i), fetchedAt: f, salaryMin: 100_000 + i * 1000, currency: "USD" });
  }
  jobsHolder.open = () => readOnlyJobsDb(nr.d1);
});
afterEach(() => vi.restoreAllMocks());

const home = async () => renderToStaticMarkup(await HomePage());

/** Текст сторінки без тегів: так його бачить людина (цифри лічильника в окремих span). */
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&#x27;/g, "'").replace(/&amp;/g, "&");

describe("home page", () => {
  it("leads with one promise: jobs matched to what you have done, no CV, a short brief and 5 a day", async () => {
    const html = await home();
    const t = text(html);
    expect(t).toContain("Crypto jobs matched to what you've done.");
    expect(t).toContain("No CV, no motivation letter. Add your X and wallets, and get jobs that fit you, up to 5 a day, by email or Telegram.");
    expect(html).toMatch(/<a[^>]*href="\/login"[^>]*>Get my jobs<\/a>/);
    expect(t).toContain("Free. About 5 clicks.");
    // Анкета ланцюжком, у кінці «Done».
    const brief = /<ol aria-label="The brief, about 5 clicks"[^>]*>(.*?)<\/ol>/.exec(html)![1];
    expect(text(brief)).toBe("XWalletsRolesWhereDone");
  });

  it("shows today's 5 as an example list with an Apply button on each row", async () => {
    const html = await home();
    const t = text(html);
    const today = html.slice(html.indexOf('id="today"'), html.indexOf("</section>", html.indexOf('id="today"')));
    expect(text(today)).toContain("Your 5 for today");
    expect(today).toContain(">EXAMPLE<");
    // Аave і чотири найсвіжіші Chain: віддалені інженери із зарплатою, одна на компанію.
    expect(today.match(/>Apply<svg/g)).toHaveLength(5);
    expect(today).toContain('aria-label="Apply: Protocol Engineer at Aave"');
    expect(today).toContain('href="https://boards.example.com/a" target="_blank" rel="noopener noreferrer nofollow"');
    expect(text(today)).toContain("$140k to $170k");
    expect(text(today)).toContain("Live jobs for an engineer who wants remote work. Yours follow your brief.");
    expect(t).not.toContain("Today's jobs did not load just now.");
  });

  it("puts the real counts in one calm line in the server HTML, rounded down", async () => {
    const t = text(await home());
    // 15 рядків, 15 компаній, 3 джерела; Wintermute опублікована 9 днів тому, тож нових 14.
    expect(t).toContain("15 live crypto jobs at 15 companies, from 3 sources.");
    expect(t).toContain("14 new this week. Updated 3 h ago.");
    expect(t).toContain("Every day we scan 3 crypto job sources");
  });

  it("rolls each digit from zero with CSS, and keeps the real digit as the text", async () => {
    const html = await home();
    // «15»: десятки роблять оберт і стають на 1 (11 рядків), одиниці два оберти й 5 (25 рядків).
    expect(html).toContain('<span class="ncj-odo-col" style="--rows:11;--seq:&quot;0\\A 1\\A 2');
    expect(html).toMatch(/--rows:25;--seq:&quot;0\\A [^"]*9\\A 0\\A 1\\A 2\\A 3\\A 4&quot;">5<\/span>/);
  });

  it("runs a ticker of the other live jobs with a salary, listed once for screen readers", async () => {
    const html = await home();
    const ticker = html.slice(html.indexOf('<div class="ncj-ticker"'));
    // Вакансії з прикладу листа в стрічку не йдуть; без зарплати теж.
    expect(ticker).not.toContain("Protocol Engineer");
    expect(ticker).not.toContain("Growth Marketing Lead");
    expect(ticker).toContain('aria-label="Solidity Engineer 5, Chain 5, Remote, from $105k"');
    expect(ticker).toContain('data-moving="true"');
    const lists = ticker.match(/<ul class="ncj-ticker-list"[^>]*>/g) ?? [];
    expect(lists).toHaveLength(2);
    expect(lists[0]).toContain('aria-label="Live jobs with a salary"');
    expect(lists[1]).toContain('aria-hidden="true"');
    // Копія не ловить фокус з клавіатури.
    const from = ticker.lastIndexOf('<ul class="ncj-ticker-list"');
    const copy = ticker.slice(from, ticker.indexOf("</ul>", from));
    expect(copy.match(/<a /g)?.length).toBe(8);
    expect(copy.match(/tabindex="-1"/g)?.length).toBe(8);
  });

  it("says what we read, and keeps the card a small link to /scoring with a moving seal", async () => {
    const html = await home();
    const t = text(html);
    expect(t).toContain("What we look at");
    for (const src of ["X", "Wallets", "EVM and Solana", "GitHub", "YouTube", "Your site"]) {
      expect(html).toContain(`>${src}<`);
    }
    expect(t).toContain("We read public data only. Your wallet addresses never go on your card.");
    expect(html).toMatch(/<a[^>]*href="\/scoring"[^>]*>See how the card works<\/a>/);
    expect(html).toContain("ncj-seal-spin");
    // Великої картки з двома боками на головній більше немає.
    expect(html).not.toContain("ncj-flip");
    expect(html).not.toContain("See how the score adds up");
  });

  it("still renders when the jobs database fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    jobsHolder.open = () => ({ all: async () => Promise.reject(new Error("D1_ERROR: overloaded")), first: async () => null });
    const html = await home();
    const t = text(html);
    expect(t).toContain("Crypto jobs matched to what you've done.");
    expect(t).toContain("Today's jobs did not load just now.");
    expect(t).not.toContain("live crypto jobs");
    expect(html).not.toContain("ncj-ticker");
    expect(html).not.toContain(">Apply<");
    expect(t).toContain("Every day we scan crypto company career pages and job boards.");
    expect(html).toMatch(/href="\/login"/);
  });

  it("still renders when the Worker has no jobs database binding", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    jobsHolder.open = () => {
      throw new Error("JOBS_DB is not bound");
    };
    expect(text(await home())).toContain("Today's jobs did not load just now.");
  });

  it("keeps companies, agents, x402 and the scoring details off the home page body", async () => {
    // Сторінка без шапки й підвалу (їх дає layout): посилання для компаній лишаються лише там.
    const body = await home();
    for (const gone of ["Ten positions", "Scouting board", "x402", "Rated on what you shipped", "Post your card", "Hiring?", "Building an agent?"]) {
      expect(body).not.toContain(gone);
    }
    expect(body).not.toContain('href="/company"');
    expect(body).not.toContain('href="/agents"');
  });
});

describe("pages that took the old home sections", () => {
  it("/scoring has the card, the finish ladder and the ten positions, and links to the formulas", () => {
    const html = renderToStaticMarkup(ScoringPage());
    // Печатка на картці малюється й потім повільно обертається.
    expect(html).toContain("ncj-seal ncj-seal-draw ncj-seal-spin");
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
