import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readOnlyJobsDb, type JobsDb } from "@/lib/jobs-db";
import { POOL_TTL_MS, resetCrawlPool } from "@/lib/jobs/pool";
import { callTool, rest, schemaErrors, setupApi } from "@/test/api-fixtures";
import { addApiKey, addCompany, addSubscription, all, run } from "@/test/crm-fixtures";
import { jobsTestDb } from "@/test/jobs-db";
import type { TestDb } from "@/test/sqlite-d1";
import { POST as mcpPost } from "../../../mcp/route";
import { GET, PATCH, POST } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

// База вакансій: прив'язку підміняємо на рівні модуля, як і в Worker лише через jobsDb().
const jobsHolder = vi.hoisted(() => ({ db: null as JobsDb | null, reads: 0 }));
vi.mock("@/lib/jobs-db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/jobs-db")>()),
  jobsDb: () => jobsHolder.db,
}));

/**
 * Вакансії компаній (T12) через справжні маршрути REST і MCP: межі компаній, поля,
 * межа відкритих, стани, черга X, жива вакансія в company_jobs_live і search_jobs,
 * пул вакансій з тим самим вікном свіжості й тегом web3, що в добірці.
 */

const HANDLERS = { GET, POST, PATCH } as const;
type Method = keyof typeof HANDLERS;
const call = (method: Method, path: string, o: Parameters<typeof rest>[3] = {}) => rest(HANDLERS[method], method, path, o);

let db: TestDb;
let nr: TestDb;
const DAY = 86_400_000;
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

beforeEach(() => {
  ({ db } = setupApi());
  resetCrawlPool();
  nr = jobsTestDb();
  const ro = readOnlyJobsDb(nr.d1);
  jobsHolder.reads = 0;
  jobsHolder.db = {
    all: (sql, ...p) => {
      jobsHolder.reads++;
      return ro.all(sql, ...p);
    },
    first: (sql, ...p) => ro.first(sql, ...p),
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function company(o: { name?: string; subscribed?: boolean; trial?: boolean } = {}) {
  const co = addCompany(db.raw, { name: o.name ?? "Acme Labs" });
  if (o.subscribed ?? true) addSubscription(db.raw, co, { status: o.trial ? "trialing" : "active" });
  const { key } = await addApiKey(db.raw, co);
  return { co, key };
}

const OPEN = {
  title: "Solidity engineer",
  roles: ["engineer"],
  work_mode: ["remote"],
  apply_url: "https://acme.io/careers/solidity",
  status: "open",
};

let nrSeq = 0;
function crawlJob(o: {
  title: string;
  company?: string;
  tags?: string[];
  location?: string | null;
  remote?: boolean;
  postedAt?: string | null;
  fetchedAt?: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  currency?: string | null;
  url?: string;
}): string {
  const id = `n${++nrSeq}`;
  run(
    nr.raw,
    `INSERT INTO jobs_cache (id, url, company, company_key, title, location, remote, salary_min, salary_max, salary_currency,
                             source, tags, dedupe_key, posted_at, fetched_at, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'greenhouse', ?, ?, ?, ?, ?)`,
    id,
    o.url ?? `https://boards.example.com/${id}`,
    o.company ?? "Chain Labs",
    (o.company ?? "Chain Labs").toLowerCase(),
    o.title,
    o.location ?? null,
    o.remote ? 1 : 0,
    o.salaryMin ?? null,
    o.salaryMax ?? null,
    o.currency ?? null,
    JSON.stringify(o.tags ?? ["web3"]),
    `${id}-d`,
    o.postedAt === undefined ? iso(2 * DAY) : o.postedAt,
    o.fetchedAt ?? iso(3_600_000),
    o.fetchedAt ?? iso(3_600_000),
  );
  return id;
}

describe("company jobs over REST", () => {
  it("an open job of a subscribed company is live, in company_jobs_live and in search_jobs; closing takes it out of all three", async () => {
    const { key } = await company();
    const posted = await call("POST", "/jobs", {
      key,
      body: { ...OPEN, salary: { min: 120000, max: 150000, currency: "USD", period: "year" }, tags: ["DeFi"] },
    });
    expect(posted.status).toBe(201);
    expect(schemaErrors("POST", "/jobs", posted)).toEqual([]);
    const id = posted.body.job_id as string;
    expect(id).toMatch(/^job_[A-Za-z0-9]{20}$/);
    expect(posted.body).toMatchObject({
      status: "open",
      live: true,
      public_url: `https://nextcryptojob.xyz/jobs/${id}`,
      work_mode: ["remote"],
      stats: { digest_shown: 0, apply_clicks: 0 },
      x_post: { state: "none" },
    });
    const days = (Date.parse(posted.body.expires_at) - Date.parse(posted.body.published_at)) / DAY;
    expect(days).toBe(60);
    expect(all(db.raw, "SELECT id FROM company_jobs_live")).toEqual([{ id }]);

    const found = await call("GET", "/public/jobs");
    expect(found.status).toBe(200);
    expect(schemaErrors("GET", "/public/jobs", found)).toEqual([]);
    expect(found.body.data).toEqual([
      expect.objectContaining({
        job_id: id,
        source: "company",
        company: "Acme Labs",
        url: `https://nextcryptojob.xyz/jobs/${id}`,
        salary: { min: 120000, max: 150000, currency: "USD", period: "year" },
      }),
    ]);

    const closed = await call("POST", `/jobs/${id}/close`, { key });
    expect(closed.status).toBe(200);
    expect(closed.body).toMatchObject({ status: "closed", live: false, public_url: null });
    expect(all(db.raw, "SELECT id FROM company_jobs_live")).toEqual([]);
    expect((await call("GET", "/public/jobs")).body.data).toEqual([]);
    // Уже закрита: та сама відповідь, без нового рядка журналу.
    expect((await call("POST", `/jobs/${id}/close`, { key })).body.status).toBe("closed");
    expect(all(db.raw, "SELECT action FROM audit_log WHERE action LIKE 'job.%' ORDER BY id")).toEqual([
      { action: "job.create" },
      { action: "job.close" },
    ]);
  });

  it("another company's key cannot list, read, change or close the job, and sees none in its list", async () => {
    const a = await company({ name: "Acme Labs" });
    const b = await company({ name: "Other Co" });
    const id = (await call("POST", "/jobs", { key: a.key, body: OPEN })).body.job_id as string;

    expect((await call("GET", "/jobs", { key: b.key })).body).toEqual({ data: [], next_cursor: null });
    for (const [method, path, body] of [
      ["GET", `/jobs/${id}`],
      ["PATCH", `/jobs/${id}`, { title: "Mine now" }],
      ["POST", `/jobs/${id}/close`],
    ] as [Method, string, unknown?][]) {
      const res = await call(method, path, { key: b.key, body });
      expect({ path, status: res.status, code: res.body.error?.code }).toEqual({ path, status: 404, code: "not_found" });
    }
    const mine = await call("GET", `/jobs/${id}`, { key: a.key });
    expect(mine.body).toMatchObject({ title: "Solidity engineer", status: "open", live: true });
  });

  it("checks the fields: https or mailto only, a city for City, min not above max, a known country, 1 to 3 roles", async () => {
    const { key } = await company();
    const bad = await call("POST", "/jobs", {
      key,
      body: {
        title: "  Go  ",
        roles: ["engineer"],
        work_mode: ["city"],
        country: "ZZ",
        salary: { min: 200000, max: 100000, currency: "USD", period: "year" },
        apply_url: "http://acme.io/jobs",
      },
    });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.fields).toEqual({
      title: "Use 3 to 120 characters.",
      city: "Add the city of the office.",
      country: "Pick a country from the list.",
      salary: "The minimum is above the maximum.",
      apply_url: "Use an https:// link or a mailto: address.",
    });
    for (const apply_url of ["javascript:alert(1)", "ftp://acme.io/x", "mailto:nobody", "https://user:pw@acme.io/"]) {
      const res = await call("POST", "/jobs", { key, body: { ...OPEN, apply_url } });
      expect({ apply_url, fields: res.body.error.details.fields }).toEqual({
        apply_url,
        fields: { apply_url: "Use an https:// link or a mailto: address." },
      });
    }
    const tiny = await call("POST", "/jobs", { key, body: { ...OPEN, salary: { min: 1000, max: 2000, currency: "USD", period: "year" } } });
    expect(tiny.body.error.details.fields).toEqual({ salary: "Enter a salary between 10,000 and 5,000,000 a year (834 to 416,666 a month)." });
    const roles = await call("POST", "/jobs", { key, body: { ...OPEN, roles: ["engineer", "bd", "trader", "finance"] } });
    expect(roles.status).toBe(422);
    const noLink = await call("POST", "/jobs", { key, body: { ...OPEN, apply_url: undefined } });
    expect(noLink.body.error.details.fields).toEqual({ apply_url: "Add an apply link (https:// or mailto:) to publish." });
    expect(all(db.raw, "SELECT id FROM company_jobs")).toEqual([]);

    const mail = await call("POST", "/jobs", {
      key,
      body: { ...OPEN, apply_url: "mailto:jobs@acme.io", work_mode: ["remote", "city"], city: " Lisbon ", country: "PT" },
    });
    expect(mail.status).toBe(201);
    expect(mail.body).toMatchObject({ apply_url: "mailto:jobs@acme.io", city: "Lisbon", country: "PT", work_mode: ["remote", "city"] });
  });

  it("a trial allows 2 open jobs: drafts do not count, the third publish is refused, closing one frees a seat", async () => {
    const { key } = await company({ trial: true });
    const one = (await call("POST", "/jobs", { key, body: OPEN })).body.job_id as string;
    await call("POST", "/jobs", { key, body: { ...OPEN, title: "Rust engineer" } });
    const draft = await call("POST", "/jobs", { key, body: { ...OPEN, title: "Data analyst", status: "draft" } });
    expect(draft.status).toBe(201);
    const third = await call("POST", "/jobs", { key, body: { ...OPEN, title: "Designer" } });
    expect(third.status).toBe(403);
    expect(third.body.error).toMatchObject({
      code: "quota_exceeded",
      message: "Your trial allows 2 open jobs. Close one or subscribe for up to 10.",
    });
    const publish = await call("PATCH", `/jobs/${draft.body.job_id}`, { key, body: { status: "open" } });
    expect(publish.status).toBe(403);
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM company_jobs WHERE status = 'open'")).toEqual([{ n: 2 }]);

    await call("POST", `/jobs/${one}/close`, { key });
    const now = await call("PATCH", `/jobs/${draft.body.job_id}`, { key, body: { status: "open" } });
    expect(now.body).toMatchObject({ status: "open", live: true });
  });

  it("draft to open to closed; back to draft is refused; Publish reopens a closed job and renews an expired one for 60 days", async () => {
    const { key } = await company();
    const draft = await call("POST", "/jobs", { key, body: { title: "Growth lead", roles: ["marketing_content"], work_mode: ["remote"] } });
    expect(draft.body).toMatchObject({ status: "draft", live: false, published_at: null, expires_at: null, public_url: null });
    const id = draft.body.job_id as string;

    const opened = await call("PATCH", `/jobs/${id}`, { key, body: { status: "open", apply_url: "https://acme.io/growth" } });
    expect(opened.body).toMatchObject({ status: "open", live: true });
    const back = await call("PATCH", `/jobs/${id}`, { key, body: { status: "draft" } });
    expect(back.status).toBe(422);
    expect(back.body.error.details.fields).toEqual({ status: "A published job cannot go back to draft. Close it instead." });
    // Відкрита без адреси бути не може.
    const unlink = await call("PATCH", `/jobs/${id}`, { key, body: { apply_url: null } });
    expect(unlink.body.error.details.fields).toEqual({ apply_url: "Add an apply link (https:// or mailto:) to publish." });

    await call("POST", `/jobs/${id}/close`, { key });
    const reopened = await call("PATCH", `/jobs/${id}`, { key, body: { status: "open" } });
    expect(reopened.body).toMatchObject({ status: "open", live: true, closed_at: null });

    run(db.raw, "UPDATE company_jobs SET expires_at = datetime('now', '-1 minute') WHERE id = ?", id);
    expect((await call("GET", `/jobs/${id}`, { key })).body.live).toBe(false);
    const renewed = await call("PATCH", `/jobs/${id}`, { key, body: { status: "open" } });
    expect(renewed.body.live).toBe(true);
    expect(Date.parse(renewed.body.expires_at) - Date.now()).toBeGreaterThan(59 * DAY);
  });

  it("an edit without changes writes nothing; a real edit writes one job.update", async () => {
    const { key } = await company();
    const id = (await call("POST", "/jobs", { key, body: OPEN })).body.job_id as string;
    const same = await call("PATCH", `/jobs/${id}`, { key, body: { title: "Solidity engineer" } });
    expect(same.status).toBe(200);
    const edited = await call("PATCH", `/jobs/${id}`, { key, body: { title: "Senior Solidity engineer", tags: ["Lending", "lending"] } });
    expect(edited.body).toMatchObject({ title: "Senior Solidity engineer", tags: ["Lending"] });
    expect(all(db.raw, "SELECT COUNT(*) AS n FROM audit_log WHERE action = 'job.update'")).toEqual([{ n: 1 }]);
  });

  it("Post on @nextcryptojob queues a text within 280 characters; unchecking withdraws it; closing skips it", async () => {
    const { key } = await company();
    const job = await call("POST", "/jobs", {
      key,
      body: {
        ...OPEN,
        work_mode: ["remote", "city"],
        city: "Lisbon",
        salary: { min: 120000, max: 150000, currency: "USD", period: "year" },
        post_on_x: true,
      },
    });
    const id = job.body.job_id as string;
    expect(job.body.x_post).toEqual({ state: "queued", url: null });
    const [row] = all<{ x_post_text: string }>(db.raw, "SELECT x_post_text FROM company_jobs WHERE id = ?", id);
    expect(row.x_post_text).toBe(
      `Acme Labs is hiring: Solidity engineer (Remote or Lisbon). Salary: $120k to $150k. Apply: nextcryptojob.xyz/jobs/${id}`,
    );

    const long = await call("PATCH", `/jobs/${id}`, {
      key,
      body: { title: `Principal ${"very ".repeat(19)}senior engineer`.slice(0, 120), city: "Lisbon ".repeat(11).trim() },
    });
    const [after] = all<{ x_post_text: string }>(db.raw, "SELECT x_post_text FROM company_jobs WHERE id = ?", id);
    expect(long.status).toBe(200);
    expect(after.x_post_text.length).toBeLessThanOrEqual(280);
    expect(after.x_post_text.endsWith(`Apply: nextcryptojob.xyz/jobs/${id}`)).toBe(true);

    expect((await call("PATCH", `/jobs/${id}`, { key, body: { post_on_x: false } })).body.x_post.state).toBe("none");
    await call("PATCH", `/jobs/${id}`, { key, body: { post_on_x: true } });
    expect((await call("POST", `/jobs/${id}/close`, { key })).body.x_post.state).toBe("skipped");
  });

  it("without a subscription the company can list, read and close, but not post or edit; its open jobs are not live", async () => {
    const co = addCompany(db.raw, { name: "Lapsed Labs" });
    const sub = addSubscription(db.raw, co);
    const { key } = await addApiKey(db.raw, co);
    const id = (await call("POST", "/jobs", { key, body: OPEN })).body.job_id as string;
    run(db.raw, "UPDATE subscriptions SET status = 'canceled' WHERE id = ?", sub);

    expect((await call("GET", `/jobs/${id}`, { key })).body).toMatchObject({ status: "open", live: false, public_url: null });
    expect(all(db.raw, "SELECT id FROM company_jobs_live")).toEqual([]);
    const post = await call("POST", "/jobs", { key, body: OPEN });
    expect(post.status).toBe(403);
    expect(post.body.error.code).toBe("subscription_required");
    expect((await call("PATCH", `/jobs/${id}`, { key, body: { title: "New" } })).body.error.code).toBe("subscription_required");
    expect((await call("POST", `/jobs/${id}/close`, { key })).body.status).toBe("closed");
  });

  it("search_jobs shows a company salary only inside the same 10k to 5M range as the digest", async () => {
    const { key } = await company();
    const id = (await call("POST", "/jobs", { key, body: OPEN })).body.job_id as string;
    run(db.raw, "UPDATE company_jobs SET salary_min = 1000, salary_max = 150000, salary_currency = 'USD', salary_period = 'year' WHERE id = ?", id);
    expect((await call("GET", "/public/jobs")).body.data[0].salary).toEqual({ min: null, max: 150000, currency: "USD", period: "year" });
  });

  it("a job hidden by the admin leaves company_jobs_live and search_jobs; the company sees it as not live", async () => {
    const { key } = await company();
    const id = (await call("POST", "/jobs", { key, body: OPEN })).body.job_id as string;
    run(db.raw, "UPDATE company_jobs SET hidden_by_admin_at = datetime('now') WHERE id = ?", id);
    expect(all(db.raw, "SELECT id FROM company_jobs_live")).toEqual([]);
    expect((await call("GET", "/public/jobs")).body.data).toEqual([]);
    expect((await call("GET", `/jobs/${id}`, { key })).body).toMatchObject({ status: "open", live: false });
  });

  it("the list pages with a cursor and filters by status", async () => {
    const { key } = await company();
    for (const title of ["Job one", "Job two", "Job three"]) {
      await call("POST", "/jobs", { key, body: { title, roles: ["engineer"], work_mode: ["remote"] } });
      run(db.raw, "UPDATE company_jobs SET updated_at = datetime(updated_at, '-' || (SELECT COUNT(*) FROM company_jobs) || ' seconds')");
    }
    const first = await call("GET", "/jobs?limit=2", { key });
    expect(first.body.data).toHaveLength(2);
    const next = await call("GET", `/jobs?limit=2&cursor=${first.body.next_cursor}`, { key });
    expect(next.body.data).toHaveLength(1);
    expect(next.body.next_cursor).toBeNull();
    const titles = [...first.body.data, ...next.body.data].map((j: { title: string }) => j.title).sort();
    expect(titles).toEqual(["Job one", "Job three", "Job two"]);
    expect((await call("GET", "/jobs?status=open", { key })).body.data).toEqual([]);
    expect((await call("GET", "/jobs?cursor=nope!", { key })).status).toBe(422);
  });
});

describe("company jobs over MCP", () => {
  it("an agent posts, edits and closes a job with tools; REST sees the same job", async () => {
    const { key } = await company();
    const posted = await callTool(mcpPost, "post_job", { ...OPEN, post_on_x: true }, { key });
    expect(posted.isError).toBeUndefined();
    const id = posted.structuredContent.job_id as string;
    const edited = await callTool(mcpPost, "update_job", { job_id: id, description: "Build lending markets." }, { key });
    expect(edited.structuredContent.description).toBe("Build lending markets.");
    expect((await call("GET", `/jobs/${id}`, { key })).body).toEqual(edited.structuredContent);
    const listed = await callTool(mcpPost, "list_jobs", {}, { key });
    expect(listed.structuredContent.data.map((j: { job_id: string }) => j.job_id)).toEqual([id]);
    const closed = await callTool(mcpPost, "close_job", { job_id: id }, { key });
    expect(closed.structuredContent).toMatchObject({ status: "closed", x_post: { state: "skipped" } });
    const [row] = all<{ meta_json: string }>(db.raw, "SELECT meta_json FROM audit_log WHERE action = 'job.close'");
    expect(JSON.parse(row.meta_json)).toMatchObject({ channel: "mcp", job_id: id });
  });
});

describe("search_jobs", () => {
  it("is public over REST and MCP: company jobs and the crawl, newest first, jobs only", async () => {
    const { key } = await company();
    const id = (await call("POST", "/jobs", { key, body: OPEN })).body.job_id as string;
    run(db.raw, "UPDATE company_jobs SET published_at = datetime('now', '-1 day') WHERE id = ?", id);
    const nrNew = crawlJob({ title: "Senior Rust Engineer", remote: true, location: "Remote", postedAt: iso(3_600_000) });
    const nrOld = crawlJob({ title: "Protocol Researcher", location: "Berlin, Germany", postedAt: iso(5 * DAY) });

    const res = await call("GET", "/public/jobs");
    expect(res.status).toBe(200);
    expect(res.body.data.map((j: { job_id: string }) => j.job_id)).toEqual([`nr_${nrNew}`, id, `nr_${nrOld}`]);
    expect(res.body.data[0]).toMatchObject({ source: "crawl", company: "Chain Labs", work_mode: ["remote"], roles: ["engineer"] });
    expect(res.body.data[2]).toMatchObject({ work_mode: ["city"], city: "Berlin, Germany", roles: ["data_research"] });
    expect(JSON.stringify(res.body)).not.toMatch(/@|telegram|candidate/i);

    const tool = await callTool(mcpPost, "search_jobs", { role: "engineer" });
    expect(tool.structuredContent.data.map((j: { job_id: string }) => j.job_id)).toEqual([`nr_${nrNew}`, id]);
  });

  it("uses the digest's freshness window and web3 filter: stale, untagged, non-crypto and roleless jobs stay out", async () => {
    const keep = crawlJob({ title: "Smart Contract Engineer", remote: true });
    crawlJob({ title: "Backend Engineer", fetchedAt: iso(4 * DAY) }); // скан не бачив 4 доби: знято з дошки
    crawlJob({ title: "Frontend Engineer", postedAt: iso(31 * DAY) }); // старше 30 днів
    crawlJob({ title: "Data Engineer", tags: ["fintech"] }); // без web3
    crawlJob({ title: "Audio Transcription Engineer" }); // не-крипто назва
    crawlJob({ title: "Software Engineer", company: "Crusoe" }); // не-крипто компанія
    crawlJob({ title: "Head Chef" }); // жодної нашої ролі
    crawlJob({ title: "Mobile Engineer", url: "javascript:alert(1)" }); // крива адреса
    const undated = crawlJob({ title: "Solidity Developer", postedAt: null });

    const ids = (await call("GET", "/public/jobs")).body.data.map((j: { job_id: string }) => j.job_id);
    // Без дати публікації в кінці: відсутнє значення не випереджає справжнє.
    expect(ids).toEqual([`nr_${keep}`, `nr_${undated}`]);
  });

  it("filters by text, role, remote, city and salary in the same currency", async () => {
    const { key } = await company();
    await call("POST", "/jobs", {
      key,
      body: { ...OPEN, title: "Lending protocol engineer", work_mode: ["city"], city: "Lisbon", tags: ["DeFi"] },
    });
    crawlJob({ title: "Rust Engineer", remote: true, location: "Remote", salaryMin: 150000, salaryMax: 200000, currency: "usd" });
    crawlJob({ title: "Growth Marketing Manager", location: "Lisboa, Portugal", salaryMin: 90000, salaryMax: 110000, currency: "EUR" });
    crawlJob({ title: "Trader", location: "New York - Hybrid", remote: true, salaryMin: 1000, currency: "USD" });

    const titles = async (query: string) =>
      (await call("GET", `/public/jobs${query}`)).body.data.map((j: { title: string }) => j.title).sort();
    expect(await titles("?q=defi")).toEqual(["Lending protocol engineer"]);
    expect(await titles("?q=acme%20lending")).toEqual(["Lending protocol engineer"]);
    expect(await titles("?role=marketing_content")).toEqual(["Growth Marketing Manager"]);
    // «Hybrid» без слова remote перемагає прапорець джерела (як у добірці).
    expect(await titles("?work_mode=remote")).toEqual(["Rust Engineer"]);
    expect(await titles("?city=Lisbon")).toEqual(["Growth Marketing Manager", "Lending protocol engineer"]);
    expect(await titles("?work_mode=city")).toEqual(["Growth Marketing Manager", "Lending protocol engineer", "Trader"]);
    expect(await titles("?salary_min=180000")).toEqual(["Rust Engineer"]);
    expect(await titles("?salary_min=100000&currency=EUR")).toEqual(["Growth Marketing Manager"]);
    // 1 000 у вилці це заглушка: такої зарплати пошук не показує.
    const trader = (await call("GET", "/public/jobs?q=trader")).body.data[0];
    expect(trader.salary).toBeNull();
    expect((await call("GET", "/public/jobs?role=nobody")).status).toBe(422);
  });

  it("pages with a cursor and reads the job pool once per isolate, not once per search", async () => {
    for (let i = 0; i < 5; i++) crawlJob({ title: `Blockchain Engineer ${i}`, remote: true, postedAt: iso((i + 1) * 3_600_000) });
    const first = await call("GET", "/public/jobs?limit=2");
    expect(first.body.data.map((j: { title: string }) => j.title)).toEqual(["Blockchain Engineer 0", "Blockchain Engineer 1"]);
    const second = await call("GET", `/public/jobs?limit=2&cursor=${first.body.next_cursor}`);
    expect(second.body.data.map((j: { title: string }) => j.title)).toEqual(["Blockchain Engineer 2", "Blockchain Engineer 3"]);
    const third = await call("GET", `/public/jobs?limit=2&cursor=${second.body.next_cursor}`);
    expect(third.body.data.map((j: { title: string }) => j.title)).toEqual(["Blockchain Engineer 4"]);
    expect(third.body.next_cursor).toBeNull();
    expect(jobsHolder.reads).toBe(1);

    // Після POOL_TTL_MS пул читається знову і бачить нові вакансії.
    crawlJob({ title: "Blockchain Engineer new", remote: true, postedAt: iso(60_000) });
    const later = Date.now() + POOL_TTL_MS + 1000;
    vi.spyOn(Date, "now").mockReturnValue(later);
    const fresh = await call("GET", "/public/jobs?limit=1");
    expect(fresh.body.data[0].title).toBe("Blockchain Engineer new");
    expect(jobsHolder.reads).toBe(2);
  });

  it("when the jobs database does not answer, company jobs still come back", async () => {
    const { key } = await company();
    const id = (await call("POST", "/jobs", { key, body: OPEN })).body.job_id as string;
    jobsHolder.db = {
      all: async () => {
        throw new Error("D1_ERROR: overloaded");
      },
      first: async () => null,
    };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const res = await call("GET", "/public/jobs");
    expect(res.status).toBe(200);
    expect(res.body.data.map((j: { job_id: string }) => j.job_id)).toEqual([id]);
  });
});
