import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken, sha256Hex } from "@/lib/auth/hash";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { resetCompanyProfiles } from "@/lib/jobs/companies";
import { resetCrawlPool } from "@/lib/jobs/pool";
import { crmDb, run } from "@/test/crm-fixtures";
import { exec, harness, resetHarness } from "@/test/harness";
import { addPoolJob, jobsTestDb } from "@/test/jobs-db";
import { migratedD1 } from "@/test/sqlite-d1";
import JobsPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

// База вакансій: прив'язку підміняємо на рівні модуля, як і в Worker лише через jobsDb().
const jobsHolder = vi.hoisted(() => ({ db: null as JobsDb | null }));
vi.mock("@/lib/jobs-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs-db")>()),
  jobsDb: () => jobsHolder.db,
}));

beforeEach(() => {
  resetHarness();
  resetCrawlPool();
  resetCompanyProfiles();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
  const nr = migratedD1([]);
  nr.raw.exec("CREATE TABLE jobs_cache (id TEXT PRIMARY KEY, url TEXT, company TEXT, title TEXT, location TEXT, remote INTEGER, salary_min INTEGER, salary_max INTEGER, salary_currency TEXT, salary_est_min INTEGER, salary_est_max INTEGER, salary_est_currency TEXT, source TEXT, posted_at TEXT, first_seen_at TEXT, fetched_at TEXT)");
  nr.raw.exec(`INSERT INTO jobs_cache (id, url, company, title, location, remote, salary_min, salary_max, salary_currency) VALUES
    ('mine', 'https://jobs.example.com/mine', 'Paying Labs', 'Protocol Engineer', 'Remote', 1, NULL, NULL, NULL),
    ('theirs', 'https://jobs.example.com/theirs', 'Other Labs', 'Secret Role', 'Remote', 1, NULL, NULL, NULL)`);
  jobsHolder.db = readOnlyJobsDb(nr.d1);
  exec("INSERT INTO users (id, email, roles, timezone) VALUES ('ada', 'ada@example.com', '[\"engineer\"]', 'Europe/Paris'), ('bob', 'bob@example.com', '[\"engineer\"]', NULL)");
});

async function signIn(userId: string): Promise<void> {
  const token = randomToken();
  exec("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))", await sha256Hex(token), userId);
  harness.jar.set(SESSION_COOKIE, token);
}

const render = async () => renderToStaticMarkup(await JobsPage());

describe("/jobs", () => {
  it("invites a visitor without a session to start a profile, instead of sending them nowhere", async () => {
    const html = await render();
    expect(html).toContain("Create a profile and get your jobs right away.");
    expect(html).toMatch(/<a[^>]*href="\/start"[^>]*>Start your profile<\/a>/);
    expect(html).toContain('href="/login"');
  });

  it("shows this person's jobs and never another person's", async () => {
    run(harness.raw, "INSERT INTO digest_runs (id, user_id, local_date, status, jobs, channel) VALUES ('dg_a', 'ada', '2026-09-12', 'sent', 1, 'email'), ('dg_b', 'bob', '2026-09-12', 'sent', 1, 'email')");
    run(harness.raw, `INSERT INTO sent (user_id, job_ref, source, digest_id, position, status, channel, why) VALUES
      ('ada', 'nr:mine', 'nextrole', 'dg_a', 1, 'sent', 'email', 'Matches your Engineer role. Remote.'),
      ('bob', 'nr:theirs', 'nextrole', 'dg_b', 1, 'sent', 'email', 'Matches your Engineer role. Remote.')`);
    await signIn("ada");
    const html = await render();
    expect(html).toContain("Sat, Sep 12");
    expect(html).toContain('href="https://jobs.example.com/mine"');
    expect(html).toContain("Protocol Engineer");
    expect(html).toContain("Matches your Engineer role. Remote.");
    expect(html).not.toContain("Secret Role");
    expect(html).not.toContain("Other Labs");
  });

  it("a web3.career job links to their apply_url as is, followed, with the referrer, and names web3.career", async () => {
    const apply = "https://web3.career/r/wczNxUTM__U4HFyv?ref=U4HFyv&utm_source=w3c";
    const nr = migratedD1([]);
    nr.raw.exec("CREATE TABLE jobs_cache (id TEXT PRIMARY KEY, url TEXT, company TEXT, title TEXT, location TEXT, remote INTEGER, salary_min INTEGER, salary_max INTEGER, salary_currency TEXT, salary_est_min INTEGER, salary_est_max INTEGER, salary_est_currency TEXT, source TEXT, posted_at TEXT, first_seen_at TEXT, fetched_at TEXT)");
    nr.raw.prepare("INSERT INTO jobs_cache (id, url, company, title, location, remote, salary_min, salary_max, salary_currency) VALUES ('w3', ?, 'Koinly', 'Community Manager', 'Remote', 1, NULL, NULL, NULL), ('gh', 'https://jobs.example.com/gh', 'Paying Labs', 'Protocol Engineer', 'Remote', 1, NULL, NULL, NULL)").run(apply);
    jobsHolder.db = readOnlyJobsDb(nr.d1);
    run(harness.raw, "INSERT INTO digest_runs (id, user_id, local_date, status, jobs, channel) VALUES ('dg_a', 'ada', '2026-09-12', 'sent', 2, 'email')");
    run(harness.raw, `INSERT INTO sent (user_id, job_ref, source, digest_id, position, status, channel, why) VALUES
      ('ada', 'nr:w3', 'nextrole', 'dg_a', 1, 'sent', 'email', 'Matches your Community role.'),
      ('ada', 'nr:gh', 'nextrole', 'dg_a', 2, 'sent', 'email', 'Matches your Engineer role.')`);
    await signIn("ada");
    const html = await render();
    // "Apply" лишається рівно apply_url, follow, з реферером (раунд 5, п.20: назва тепер веде на
    // внутрішню /jobs/<id>, уся картка клікабельна, лише Apply назовні; web3.career TOS торкається
    // лише Apply).
    const links = [...html.matchAll(new RegExp(`<a [^>]*href="${apply.replace(/[?]/g, "\\?").replace(/&/g, "&amp;")}"[^>]*>`, "g"))].map((m) => m[0]);
    expect(links).toHaveLength(1);
    for (const w3 of links) {
      expect(w3).toContain('rel="noopener"');
      expect(w3).toContain('target="_blank"');
      expect(w3).not.toMatch(/nofollow|noreferrer|ugc|sponsored/);
    }
    expect(html).toMatch(/>Apply<svg/);
    expect(html).toContain("via web3.career");
    expect(html.match(/via web3\.career/g)).toHaveLength(1);
    // Назва й уся картка ведуть на внутрішню сторінку вакансії, не одразу на дошку.
    expect(html).toContain('href="/jobs/w3"');
    expect(html).toContain('href="/jobs/gh"');
    expect(html).toContain('href="https://jobs.example.com/gh" target="_blank" rel="noopener noreferrer nofollow"');
  });

  it("a board estimate shows as a muted estimate line, never as the salary", async () => {
    const nr = migratedD1([]);
    nr.raw.exec("CREATE TABLE jobs_cache (id TEXT PRIMARY KEY, url TEXT, company TEXT, title TEXT, location TEXT, remote INTEGER, salary_min INTEGER, salary_max INTEGER, salary_currency TEXT, salary_est_min INTEGER, salary_est_max INTEGER, salary_est_currency TEXT, source TEXT, posted_at TEXT, first_seen_at TEXT, fetched_at TEXT)");
    nr.raw.exec(`INSERT INTO jobs_cache VALUES
      ('w3', 'https://web3.career/r/wczNxUTM__U4HFyv', 'Koinly', 'Community Manager', 'Remote', 1, NULL, NULL, NULL, 180000, 225000, 'USD', 'board:web3career', NULL, NULL, NULL),
      ('gh', 'https://jobs.example.com/gh', 'Paying Labs', 'Protocol Engineer', 'Remote', 1, 120000, 150000, 'USD', 300000, 400000, 'USD', 'greenhouse:x', NULL, NULL, NULL)`);
    jobsHolder.db = readOnlyJobsDb(nr.d1);
    run(harness.raw, "INSERT INTO digest_runs (id, user_id, local_date, status, jobs, channel) VALUES ('dg_a', 'ada', '2026-09-12', 'sent', 2, 'email')");
    run(harness.raw, `INSERT INTO sent (user_id, job_ref, source, digest_id, position, status, channel, why) VALUES
      ('ada', 'nr:w3', 'nextrole', 'dg_a', 1, 'sent', 'email', 'Matches your Community role.'),
      ('ada', 'nr:gh', 'nextrole', 'dg_a', 2, 'sent', 'email', 'Matches your Engineer role.')`);
    await signIn("ada");
    const html = await render();
    // Оцінка приглушеним пунктиром, окремо від зарплати (зарплата звичайним текстом, round4).
    expect(html).toMatch(/<span class="[^"]*border-dashed[^"]*text-ink-muted[^"]*">est\. \$180k to \$225k \(web3\.career estimate\)<\/span>/);
    // Зарплата роботодавця є: оцінки не видно.
    expect(html).toMatch(/<span class="[^"]*text-right[^"]*">\$120k to \$150k<\/span>/);
    expect(html).not.toContain("$300k");
  });

  it("a company job links to its page on the site in the same tab, not to the company's address", async () => {
    run(harness.raw, "INSERT INTO companies (id, name, kind, status, terms_version, terms_accepted_at) VALUES ('co_x', 'Acme Labs', 'company', 'active', 'v1', datetime('now'))");
    run(
      harness.raw,
      `INSERT INTO company_jobs (id, company_id, status, title, apply_url, expires_at, created_via)
       VALUES ('job_live', 'co_x', 'open', 'Solidity Auditor', 'https://acme.io/jobs', datetime('now', '+30 days'), 'web')`,
    );
    run(harness.raw, "INSERT INTO digest_runs (id, user_id, local_date, status, jobs, channel) VALUES ('dg_a', 'ada', '2026-09-12', 'sent', 1, 'email')");
    run(harness.raw, "INSERT INTO sent (user_id, job_ref, source, digest_id, position, status, channel, why) VALUES ('ada', 'co:job_live', 'company', 'dg_a', 1, 'sent', 'email', 'Matches your Engineer role.')");
    await signIn("ada");
    const html = await render();
    expect(html).toMatch(/<a [^>]*href="\/jobs\/job_live"/);
    expect(html).not.toContain("acme.io/jobs");
    expect(html).not.toMatch(/href="\/jobs\/job_live"[^>]*target="_blank"/);
    expect(html).toContain("Posted by Acme Labs on NextCryptoJob");
  });

  it("says the jobs could not be loaded when our DB fails, instead of an error page", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await signIn("ada");
    const d1 = harness.env.DB;
    harness.env.DB = { prepare: d1.prepare.bind(d1), batch: async () => Promise.reject(new Error("D1_ERROR: overloaded")) } as unknown as D1Database;
    const html = await render();
    expect(html).toContain("We could not load your jobs right now.");
    expect(html).not.toContain("Your first jobs are coming.");
  });

  it("explains an empty page and links to settings", async () => {
    await signIn("bob");
    const html = await render();
    expect(html).toContain("Your first jobs are coming.");
    expect(html).toContain("every day at 07:00 (UTC), by email.");
    expect(html).toContain('href="/settings"');
  });
});

describe("/jobs: Jobs for you now", () => {
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

  beforeEach(() => {
    const nr = jobsTestDb();
    const f = hoursAgo(2);
    addPoolJob(nr.raw, { id: "eng1", title: "Solidity Engineer", company: "Aave", postedAt: hoursAgo(5), fetchedAt: f });
    addPoolJob(nr.raw, { id: "eng2", title: "Rust Engineer", company: "Lido", postedAt: hoursAgo(9), fetchedAt: f, salaryMin: 120_000, salaryMax: 150_000, currency: "USD" });
    addPoolJob(nr.raw, { id: "trd1", title: "Crypto Trader", company: "Wintermute", postedAt: hoursAgo(3), fetchedAt: f });
    addPoolJob(nr.raw, { id: "lis1", title: "Backend Engineer", company: "Kiln", location: "Lisbon", remote: false, postedAt: hoursAgo(4), fetchedAt: f });
    jobsHolder.db = readOnlyJobsDb(nr.d1);
    exec("UPDATE users SET roles = '[\"trader\"]', remote_mode = 'remote' WHERE id = 'bob'");
    exec("UPDATE users SET remote_mode = 'remote' WHERE id = 'ada'");
  });

  it("lists saved jobs on their own, even one that never came in a digest, with the day it was still open", async () => {
    harness.raw.exec(`INSERT INTO saved_jobs (user_id, job_ref, created_at) VALUES
      ('ada', 'nr:mine', '2026-09-16 10:00:00'), ('ada', 'nr:gone', '2026-09-15 10:00:00'), ('bob', 'nr:theirs', '2026-09-16 10:00:00')`);
    const nr = migratedD1([]);
    nr.raw.exec("CREATE TABLE jobs_cache (id TEXT PRIMARY KEY, url TEXT, company TEXT, title TEXT, location TEXT, remote INTEGER, salary_min INTEGER, salary_max INTEGER, salary_currency TEXT, salary_est_min INTEGER, salary_est_max INTEGER, salary_est_currency TEXT, source TEXT, posted_at TEXT, first_seen_at TEXT, fetched_at TEXT)");
    nr.raw.exec(`INSERT INTO jobs_cache (id, url, company, title, location, remote, posted_at, first_seen_at, fetched_at) VALUES
      ('mine', 'https://jobs.example.com/mine', 'Paying Labs', 'Protocol Engineer', 'Remote', 1, '2026-09-03T10:00:00.000Z', '2026-09-04T04:30:00.000Z', '2026-09-16T04:40:00.000Z'),
      ('theirs', 'https://jobs.example.com/theirs', 'Other Labs', 'Secret Role', 'Remote', 1, NULL, NULL, NULL)`);
    jobsHolder.db = readOnlyJobsDb(nr.d1);
    await signIn("ada");
    const html = await render();
    const saved = html.slice(html.indexOf('id="saved-h"'), html.indexOf('id="sent-h"'));
    expect(saved).toContain("Saved (2)");
    expect(saved).toContain("Protocol Engineer");
    expect(saved).toContain("Posted Sep 3. Still open on Sep 16.");
    expect(saved).toContain("This job is no longer listed.");
    expect(saved.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html).not.toContain("Secret Role");
  });

  it("shows no Saved block when nothing is saved", async () => {
    await signIn("ada");
    expect(await render()).not.toContain('id="saved-h"');
  });

  it("shows live matches for the signed-in person's brief only, right away", async () => {
    await signIn("ada");
    const ada = await render();
    expect(ada).toContain("Your best matches today");
    expect(ada).toContain("Solidity Engineer");
    expect(ada).toContain("Rust Engineer");
    expect(ada).toMatch(/<span class="[^"]*text-right[^"]*">\$120k to \$150k<\/span>/);
    expect(ada).toContain("Why this fits you");
    expect(ada).toContain("Matches your Engineer role.");
    expect(ada).toContain("Remote, as you asked.");
    // Бобова роль і місто, яке ніхто не просив, у вибір Ади не йдуть.
    expect(ada).not.toContain("Crypto Trader");
    expect(ada).not.toContain("Backend Engineer");

    harness.jar.delete(SESSION_COOKIE);
    await signIn("bob");
    const bob = await render();
    expect(bob).toContain("Crypto Trader");
    expect(bob).not.toContain("Solidity Engineer");
  });

  it("leaves out what the digest already sent to this person, and only to this person", async () => {
    run(harness.raw, "INSERT INTO digest_runs (id, user_id, local_date, status, jobs, channel) VALUES ('dg_b', 'bob', '2026-09-12', 'sent', 1, 'email'), ('dg_a', 'ada', '2026-09-12', 'sent', 1, 'email')");
    run(harness.raw, `INSERT INTO sent (user_id, job_ref, source, digest_id, position, status, channel, why) VALUES
      ('bob', 'nr:eng1', 'nextrole', 'dg_b', 1, 'sent', 'email', 'x'),
      ('ada', 'nr:eng2', 'nextrole', 'dg_a', 1, 'failed', 'email', 'x')`);
    await signIn("ada");
    const html = await render();
    const now = html.slice(html.indexOf("Your best matches today"), html.indexOf("Sent to you"));
    expect(now).toContain("Solidity Engineer");
    expect(now).not.toContain("Rust Engineer");
  });

  it("says why nothing matched and offers to edit the brief", async () => {
    exec("UPDATE users SET remote_mode = 'city', city = 'Berlin' WHERE id = 'ada'");
    await signIn("ada");
    const html = await render();
    expect(html).toContain("Nothing in Berlin right now.");
    expect(html).toContain("2 jobs for your roles are remote. Add remote work to see them.");
    expect(html).toContain('href="/welcome?step=place"');
  });

  it("asks for roles first when the brief has none", async () => {
    exec("UPDATE users SET roles = '[]' WHERE id = 'ada'");
    await signIn("ada");
    const html = await render();
    expect(html).toContain("Pick your roles first.");
    expect(html).not.toContain("Sent to you");
  });

  it("says live jobs are unavailable when the jobs database fails, and keeps the rest of the page", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    jobsHolder.db = { all: async () => Promise.reject(new Error("D1_ERROR: overloaded")), first: async () => null };
    await signIn("ada");
    const html = await render();
    expect(html).toContain("We could not load live jobs right now.");
    expect(html).toContain("Your first jobs are coming.");
  });

  it("offers to improve the matches after the brief: edit the brief, or add X, wallets and GitHub", async () => {
    await signIn("ada");
    // Анкету ще не пройдено: покращувати нічого.
    expect(await render()).not.toContain("Improve your matches");
    exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('ada', 'scoring', 1, 'v1')");
    exec("UPDATE users SET onboarding_step = 'x' WHERE id = 'ada'");
    const html = await render();
    expect(html).toContain("Not quite right? Improve your matches");
    expect(html).toMatch(/<a [^>]*href="\/welcome\?step=target"[^>]*>Describe the job you want<\/a>/);
    expect(html).toContain('href="/welcome?step=roles"');
    expect(html).toContain('href="/welcome?step=place"');
    expect(html).toMatch(/<a [^>]*href="\/welcome\?step=x"[^>]*>Add X, wallets or GitHub<\/a>/);
    exec("UPDATE users SET onboarding_step = 'done' WHERE id = 'ada'");
    const done = await render();
    expect(done).toContain("Improve your matches");
    expect(done).not.toContain("Add X, wallets or GitHub");
    expect(done).toMatch(/<a [^>]*href="\/profile"[^>]*>See your score and sources<\/a>/);
  });

  it("says how many live jobs were checked and from how many sources, with real numbers", async () => {
    await signIn("ada");
    const html = await render();
    // 4 живі вакансії в пулі, одне джерело (greenhouse:chainlabs); Аді підходять дві.
    expect(html).toContain("We checked 4 live jobs from 1 source. <strong");
    expect(html).toContain(">These 2 fit you best.</strong>");
  });

  it("every match has an Apply button straight to the job, with the link rules, and a letter or logo", async () => {
    await signIn("ada");
    const html = await render();
    const apply = [...html.matchAll(/<a [^>]*href="([^"]+)"[^>]*>Apply<svg/g)].map((m) => m[0]);
    expect(apply).toHaveLength(2);
    for (const a of apply) {
      expect(a).toContain('target="_blank"');
      expect(a).toContain('rel="noopener noreferrer nofollow"');
      expect(a).toMatch(/href="https:\/\/boards\.example\.com\/eng[12]"/);
    }
    // Без домену в реєстрі: літера компанії, без картинки.
    expect(html).not.toContain("/api/logo/");
  });

  it("the registry's domain and about sentence show on the card", async () => {
    const nr = jobsTestDb();
    addPoolJob(nr.raw, { id: "eng1", title: "Solidity Engineer", company: "Aave", postedAt: hoursAgo(5), fetchedAt: hoursAgo(2) });
    nr.raw.exec(`INSERT INTO companies (slug, name, ats_provider, ats_slug, discovered_via, domain, about)
                 VALUES ('aave', 'Aave', 'greenhouse', 'aave', 'manual', 'aave.com', 'Aave runs lending markets on many chains.')`);
    jobsHolder.db = readOnlyJobsDb(nr.d1);
    await signIn("ada");
    const html = await render();
    expect(html).toContain('src="/api/logo/aave.com"');
    expect(html).toMatch(/About the company<\/p><p[^>]*>Aave runs lending markets on many chains\.<\/p>/);
    expect(html).toContain("aave.com");
  });

  it("shows a fresh token chip with the company's site link; hides a stale one", async () => {
    const nr = jobsTestDb();
    addPoolJob(nr.raw, { id: "eng1", title: "Solidity Engineer", company: "Aave", postedAt: hoursAgo(5), fetchedAt: hoursAgo(2) });
    nr.raw.exec(`INSERT INTO companies (slug, name, ats_provider, ats_slug, discovered_via, domain,
                   token_symbol, token_confidence, token_checked_at, token_price_usd, token_mcap_usd, token_change_24h, token_updated_at)
                 VALUES ('aave', 'Aave', 'greenhouse', 'aave', 'manual', 'aave.com',
                   'AAVE', 'homepage', datetime('now'), 90.5, 1400000000, -2.3, datetime('now'))`);
    jobsHolder.db = readOnlyJobsDb(nr.d1);
    await signIn("ada");
    const html = await render();
    expect(html).toContain('href="https://aave.com"');
    expect(html).toContain("$AAVE");
    expect(html).toContain("$90.50");
    expect(html).toContain("MC $1.4B");
    expect(html).toContain("-2.3%");

    // Ціна старша за 3 доби: сайт компанії лишається, чипа немає.
    resetCrawlPool();
    resetCompanyProfiles();
    run(nr.raw, "UPDATE companies SET token_updated_at = datetime('now', '-10 days') WHERE slug = 'aave'");
    const html2 = await render();
    expect(html2).toContain('href="https://aave.com"');
    expect(html2).not.toContain("$AAVE");
  });
});
