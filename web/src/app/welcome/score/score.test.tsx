import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth/session";
import { type JobsDb, readOnlyJobsDb } from "@/lib/jobs-db";
import { resetCompanyProfiles } from "@/lib/jobs/companies";
import { resetCrawlPool } from "@/lib/jobs/pool";
import { exec, harness, RedirectCalled, resetHarness, rows } from "@/test/harness";
import { jobsTestDb } from "@/test/jobs-db";
import { ensureScoreAction, issueFirstCardAction } from "../actions/score";
import ScorePage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  useRouter: () => ({ refresh: () => undefined, push: () => undefined }),
}));

// База вакансій: прив'язку підміняємо на рівні модуля, як і в тестах /jobs.
const jobsHolder = vi.hoisted(() => ({ db: null as JobsDb | null }));
vi.mock("@/lib/jobs-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs-db")>()),
  jobsDb: () => jobsHolder.db,
}));

/** Жива вакансія ролі engineer, як мінімум POOL_SQL (db/jobs 0001_schema.sql). */
function addEngineerJob(): void {
  const { raw, d1 } = jobsTestDb();
  raw
    .prepare(
      `INSERT INTO jobs_cache (id, url, company, company_key, title, location, remote, source, tags, dedupe_key,
                               posted_at, fetched_at, first_seen_at)
       VALUES ('j1', 'https://jobs.example.com/j1', 'Acme', 'acme', 'Protocol Engineer', 'Remote', 1,
               'board:test', '["web3"]', 'acme-protocol-engineer', datetime('now'), datetime('now'), datetime('now'))`,
    )
    .run();
  jobsHolder.db = readOnlyJobsDb(d1);
}

/** Людина, що пройшла анкету й кроки балу: ролі, згода, X. */
async function finished(roles = '["bd","marketing_content"]') {
  exec("INSERT INTO users (id, email, onboarding_step, roles) VALUES ('u', 'ada@example.com', 'done', ?)", roles);
  exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('u', 'scoring', 1, 'v1')");
  exec("INSERT INTO identities (user_id, kind, value) VALUES ('u', 'x', 'ada')");
  exec("INSERT INTO identities (user_id, kind, value) VALUES ('u', 'evm', ?)", `0x${"a".repeat(40)}`);
  await createSession("u", null);
}

function job(status: string, agoSeconds = 30) {
  exec(
    "INSERT INTO score_jobs (user_id, reason, status, queued_at, started_at) VALUES ('u', 'connect', ?, datetime('now', ?), datetime('now', ?))",
    status,
    `-${agoSeconds} seconds`,
    `-${agoSeconds - 1} seconds`,
  );
}

function score(role: string, value: number | null) {
  exec(
    "INSERT INTO scores (user_id, role, score, breakdown_json, formula_version) VALUES ('u', ?, ?, '{}', 'v6')",
    role,
    value,
  );
}

async function render(): Promise<string> {
  return renderToStaticMarkup(await ScorePage());
}

beforeEach(() => {
  resetHarness();
  resetCrawlPool();
  resetCompanyProfiles();
  jobsHolder.db = null;
  harness.headers = new Headers({ host: "nextcryptojob.xyz", "cf-connecting-ip": "203.0.113.9" });
});

describe("ensureScoreAction", () => {
  it("queues a score at once, and then says it is queued rather than adding a second job", async () => {
    await finished();
    await expect(ensureScoreAction()).resolves.toEqual({ state: "queued" });
    await expect(ensureScoreAction()).resolves.toEqual({ state: "queued" });
    expect(rows("SELECT status FROM score_jobs")).toEqual([{ status: "queued" }]);
  });

  it("says how long to wait when the last job is under a minute old", async () => {
    await finished();
    job("done", 20);
    const res = await ensureScoreAction();
    expect(res.state).toBe("wait");
    expect(res.state === "wait" && res.seconds).toBeGreaterThan(30);
  });
});

describe("issueFirstCardAction", () => {
  it("makes the first card for the role, named after the X handle, and reuses it next time", async () => {
    await finished();
    score("bd", 44);
    const first = await issueFirstCardAction("bd");
    expect(first).toMatchObject({ ok: true });
    await expect(issueFirstCardAction("bd")).resolves.toEqual(first);
    expect(rows("SELECT role, score, display_name, revoked_at FROM cards")).toEqual([
      { role: "bd", score: 44, display_name: "@ada", revoked_at: null },
    ]);
  });

  it("refuses a role without a score", async () => {
    await finished();
    await expect(issueFirstCardAction("bd")).resolves.toEqual({ ok: false, message: "There is no score for this role yet." });
  });
});

describe("/welcome/score", () => {
  it("sends a person without X back to the X step, which is required", async () => {
    exec("INSERT INTO users (id, email, onboarding_step, roles) VALUES ('u', 'ada@example.com', 'done', '[\"bd\"]')");
    exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('u', 'scoring', 1, 'v1')");
    await createSession("u", null);
    const err = await ScorePage().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RedirectCalled);
    expect((err as RedirectCalled).url).toBe("/welcome?step=x");
  });

  it("shows 'Scoring your work…' while the job waits, and when sources changed after the last score", async () => {
    await finished();
    job("queued", 3);
    expect(await render()).toContain("Scoring your work…");

    exec("UPDATE score_jobs SET status = 'done'");
    exec("INSERT INTO audit_log (actor, action, target, meta_json, at) VALUES ('u', 'sources.change', 'u', '{}', datetime('now'))");
    expect(await render()).toContain("Scoring your work…");
  });

  it("once scored, shows the best role and makes the card from the page (no card yet)", async () => {
    await finished();
    job("done");
    score("bd", 44.6);
    score("marketing_content", 61.2);
    const html = await render();
    expect(html).toContain("We scored you <span");
    expect(html).toMatch(/61<\/span> in Marketing &amp; content, level 7 of 10/);
    expect(html).toContain("Your other roles: BD &amp; partnerships 44.");
    expect(html).toContain("Making your card…");
    expect(html).toContain("Improve your score");
    expect(html).toContain("Add more wallets: you have 1 of 10.");
  });

  it("with the card made: the picture, Download image and Share on X, no repeated public-card blurb (item 5)", async () => {
    await finished();
    job("done");
    score("marketing_content", 61.2);
    const issued = await issueFirstCardAction("marketing_content");
    if (!issued.ok) throw new Error(issued.message);
    const html = await render();
    expect(html).toContain(`href="/c/${issued.slug}/share/tall" download=""`);
    expect(html).toContain("Download image");
    expect(html).toMatch(/href="https:\/\/x\.com\/intent\/post\?text=I%20scored%2061%20in%20Marketing%20%26%20content/);
    expect(html).toContain(encodeURIComponent(`https://nextcryptojob.xyz/c/${issued.slug}`));
    expect(html).toContain("Share on X");
    expect(html).not.toContain("Open your public card");
    expect(html).not.toContain("you can change it on your profile");
    expect(html).not.toContain("Making your card…");
  });

  it("says why when none of the person's roles has a score yet", async () => {
    await finished('["engineer"]');
    job("done");
    exec(
      "INSERT INTO scores (user_id, role, score, breakdown_json, formula_version) VALUES ('u', 'engineer', NULL, ?, 'v6')",
      JSON.stringify({ reason: "missing_anchor:gh_eng" }),
    );
    const html = await render();
    expect(html).toContain("We could not score your roles yet.");
    expect(html).toContain("Connect GitHub to get an Engineer score.");
    expect(html).not.toContain("Download image");
  });
});

// Раунд 5, п.4: вакансії важливіші за картку, тож ідуть першими й виділені; під ними «завтра
// надішлемо ще» за каналом.
describe("jobs before the card (item 4)", () => {
  it("shows the matching job above the card, and says jobs keep coming by email (default channel)", async () => {
    await finished('["engineer"]');
    addEngineerJob();
    job("done");
    score("engineer", 61.2);
    const issued = await issueFirstCardAction("engineer");
    if (!issued.ok) throw new Error(issued.message);
    const html = await render();

    expect(html).toContain("Your jobs");
    expect(html).toContain("Protocol Engineer");
    expect(html).toContain("Tomorrow we send you more jobs by email.");
    // Вакансії йдуть РАНІШЕ картки в розмітці.
    expect(html.indexOf("Your jobs")).toBeLessThan(html.indexOf("ncj-card"));
    expect(html.indexOf("Protocol Engineer")).toBeLessThan(html.indexOf("ncj-card"));
  });

  it("says jobs keep coming in Telegram when that is the chosen channel", async () => {
    exec("INSERT INTO users (id, email, channel, onboarding_step, roles) VALUES ('u', 'ada@example.com', 'telegram', 'done', '[\"engineer\"]')");
    exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('u', 'scoring', 1, 'v1')");
    exec("INSERT INTO identities (user_id, kind, value) VALUES ('u', 'x', 'ada')");
    await createSession("u", null);
    addEngineerJob();
    job("done");
    score("engineer", 61.2);
    const html = await render();
    expect(html).toContain("Tomorrow we send you more jobs in Telegram.");
    expect(html).not.toContain("by email.");
  });

  it("has no jobs section when nothing matches, and the card still shows", async () => {
    await finished('["engineer"]');
    job("done");
    score("engineer", 61.2);
    const html = await render();
    expect(html).not.toContain("Your jobs");
    expect(html).not.toContain("Tomorrow we send you");
    expect(html).toContain("Making your card…");
  });
});
