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
  it("leads with one promise and a brief box that carries the text to the brief", async () => {
    const html = await home();
    const t = text(html);
    expect(t).toContain("Get hired for what you've actually done.");
    expect(t).toContain("The easy way to find a crypto job. We match you by your real achievements: your X, your wallets, your GitHub.");
    // Бриф іде GET на /start (кука для першого кроку анкети), без ланцюжка кроків.
    expect(html).toMatch(/<form id="find"[^>]*action="\/start" method="get"/);
    expect(html).toMatch(/<textarea id="brief" name="brief"[^>]*maxLength="400"/i);
    expect(html).toMatch(/<button type="submit"[^>]*>Find a job<svg/);
    expect(t).not.toContain("Free for job seekers");
    expect(html).not.toContain("The brief, about 5 clicks");
  });

  it("puts a level 10 example card in front of the hero stack, with the finishes behind it as buttons", async () => {
    const html = await home();
    const stage = html.slice(html.indexOf('class="ncj-stage"'), html.indexOf('id="board-h"'));
    expect(stage).toContain("ncj-tilt");
    expect(stage).toContain("ncj-sweep");
    expect(stage).toContain("ncj-seal ncj-seal-spin");
    // Позначку «Example card» на головній замінює підпис під стосом (власник 15.09, п.8).
    expect(text(stage)).not.toContain("Example card");
    expect(text(stage)).toContain("Black finish, level 10 of 10.");
    expect(text(stage)).toContain("Click a card behind to see another finish.");
    // Раунд 6: три заготовки позаду це кнопки, кожна називає свою обробку.
    expect(stage.match(/class="ncj-slot ncj-slot-back"/g)).toHaveLength(3);
    for (const finish of ["Lavender", "Mint", "Paper"]) {
      expect(stage).toContain(`Show the ${finish} card`);
    }
  });

  it("counts live jobs with a rolling counter and lists them in a vertical feed", async () => {
    const html = await home();
    const board = html.slice(html.indexOf('class="ncj-board"'), html.indexOf("</section>", html.indexOf('class="ncj-board"')));
    // 15 рядків у пулі, 3 джерела.
    expect(text(board)).toContain("15 live jobs");
    expect(text(board)).toContain("3 sources");
    expect(text(board)).toContain("Updated daily");
    expect(board).toContain('<span class="ncj-odo-col" style="--rows:11;--seq:&quot;0\\A 1\\A 2');
    // Сьогоднішні п'ять і далі стрічка: 14 рядків, одна вакансія на компанію.
    expect(board).toContain('aria-label="Protocol Engineer, Aave, Remote, $140k to $170k"');
    expect(board).toContain('href="https://boards.example.com/a" target="_blank" rel="noopener noreferrer nofollow"');
    expect(board).toContain('data-moving="true"');
    const lists = board.match(/<ul[^>]*>/g) ?? [];
    expect(lists).toHaveLength(2);
    expect(lists[1]).toContain('aria-hidden="true"');
    // Копія не ловить фокус з клавіатури.
    const from = board.lastIndexOf("<ul");
    const copy = board.slice(from, board.indexOf("</ul>", from));
    expect(copy.match(/<a /g)?.length).toBe(copy.match(/tabindex="-1"/g)?.length);
    expect(text(html)).not.toContain("Today's jobs did not load just now.");
  });

  it("says what we read: X, wallets and GitHub, delivery by Telegram or email", async () => {
    const t = text(await home());
    expect(t).toContain("We read the work you've already done, and find jobs that fit it.");
    // Раунд 5, п.12: без позначок Required/Optional і без рядка «Public data only.».
    expect(t).toContain("X");
    expect(t).toContain("Wallets");
    expect(t).toContain("GitHub");
    expect(t).not.toContain("Required");
    expect(t).not.toContain("Optional");
    expect(t).toContain("Up to 5 matching jobs a day, by Telegram or email.");
    expect(t).not.toContain("Public data only.");
    expect(t).not.toContain("Free for job seekers");
  });

  it("still renders when the jobs database fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    jobsHolder.open = () => ({ all: async () => Promise.reject(new Error("D1_ERROR: overloaded")), first: async () => null });
    const html = await home();
    const t = text(html);
    expect(t).toContain("Get hired for what you've actually done.");
    expect(t).toContain("Today's jobs did not load just now.");
    expect(t).not.toContain("live jobs");
    expect(html).not.toContain("ncj-feed");
    expect(html).toMatch(/action="\/start"/);
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
    for (const gone of ["Ten positions", "Scouting board", "x402", "How your score works", "Hiring?", "Building an agent?"]) {
      expect(body).not.toContain(gone);
    }
    expect(body).not.toContain('href="/company"');
    expect(body).not.toContain('href="/agents"');
  });
});

describe("pages that took the old home sections", () => {
  it("/scoring says how the score works, shows the round seal for four finishes, and links to the formulas", () => {
    const html = renderToStaticMarkup(ScoringPage());
    const t = text(html);
    // Печатка на картці малюється й потім повільно обертається.
    expect(html).toContain("ncj-seal ncj-seal-draw ncj-seal-spin");
    expect(t).toContain("How your score works");
    expect(t).toContain("For an engineer, GitHub counts most. For a trader, your wallets do.");
    expect(t).toContain("Your level is a seal no one else has");
    for (const f of ["Paper", "Mint", "Lavender", "Chrome", "Black"]) expect(t).toContain(f);
    // Власник 14.09 (A3): без десяти варіантів.
    expect(t).not.toContain("Ten positions");
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
