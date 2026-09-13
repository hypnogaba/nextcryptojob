import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken, sha256Hex } from "@/lib/auth/hash";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { COMPANY_COOKIE } from "@/lib/crm/context";
import { addCompany, addMember, addSubscription, addUser, crmDb } from "@/test/crm-fixtures";
import { exec, fakeCookieJar, harness, RedirectCalled, resetHarness, rows } from "@/test/harness";
import DashboardPage from "./(crm)/dashboard/page";
import JobPage from "./(crm)/jobs/[id]/page";
import { closeJobAction, saveJobAction, type JobFormState } from "./(crm)/jobs/actions";
import NewJobPage from "./(crm)/jobs/new/page";
import JobsPage from "./(crm)/jobs/page";
import CrmLayout from "./(crm)/layout";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  usePathname: () => "/company/jobs",
  notFound: (): never => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

/**
 * Екрани вакансій компанії (T12, специфікація 10.2): список з "Live" / "Not live: {reason}",
 * нова вакансія, зміна, "Publish", "Close job". Усе через реєстр дій з актором сесії
 * (RL_WEB) і прихованим company_id: компанія B не бачить і не чіпає вакансій компанії A.
 */

beforeEach(() => {
  resetHarness({ SITE_URL: "https://nextcryptojob.xyz" } as never);
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
});

async function signIn(userId: string, companyId: string): Promise<void> {
  const token = randomToken();
  exec("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))", await sha256Hex(token), userId);
  harness.jar = fakeCookieJar();
  harness.jar.set(SESSION_COOKIE, token);
  harness.jar.set(COMPANY_COOKIE, companyId);
}

async function company(name: string, o: { subscribed?: boolean } = {}) {
  const co = addCompany(harness.raw, { name });
  if (o.subscribed ?? true) addSubscription(harness.raw, co);
  const owner = addUser(harness.raw, { email: `${name.toLowerCase().replace(/\s+/g, "")}@example.com`, visible: false });
  addMember(harness.raw, co, owner, "owner");
  await signIn(owner, co);
  return { co, owner, signIn: () => signIn(owner, co) };
}

function jobForm(companyId: string, fields: Record<string, string | string[]> = {}): FormData {
  const f = new FormData();
  const all: Record<string, string | string[]> = {
    company_id: companyId,
    job_id: "",
    title: "Solidity engineer",
    roles: ["engineer"],
    work_mode: ["remote"],
    city: "",
    country: "",
    salary_min: "120,000",
    salary_max: "150000",
    salary_currency: "USD",
    salary_period: "year",
    apply_url: "https://acme.io/careers/solidity",
    description: "Build lending markets.",
    tags: "DeFi, Solidity",
    intent: "open",
    ...fields,
  };
  for (const [k, v] of Object.entries(all)) {
    if (Array.isArray(v)) for (const item of v) f.append(k, item);
    else f.set(k, v);
  }
  return f;
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function html(node: Promise<React.ReactNode> | React.ReactNode): Promise<string> {
  return renderToStaticMarkup(await node)
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&");
}

async function redirectOf(p: Promise<unknown>): Promise<string> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RedirectCalled);
  return (err as RedirectCalled).url;
}

const sp = (p: Record<string, string> = {}) => ({ searchParams: Promise.resolve(p) });
const jobPage = (id: string, p: Record<string, string> = {}) => ({ params: Promise.resolve({ id }), searchParams: Promise.resolve(p) });
const EMPTY: JobFormState = {};

async function publish(companyId: string, fields: Record<string, string | string[]> = {}): Promise<string> {
  const url = await redirectOf(saveJobAction(EMPTY, jobForm(companyId, fields)));
  const id = new URL(url, "https://x").searchParams.get("job");
  expect(id).toMatch(/^job_/);
  return id!;
}

describe("jobs screens", () => {
  it("Jobs is in the menu; a new company sees the empty state and the first step links to New job", async () => {
    await company("Acme Labs");
    expect(await html(CrmLayout({ children: null }))).toContain(">Jobs<");
    const list = await html(JobsPage(sp()));
    expect(list).toContain("No jobs yet. Jobs you publish appear in daily digests of matching candidates.");
    expect(list).toContain("0 of 10 open");
    expect(list).toContain('href="/company/jobs/new"');
    expect(await html(DashboardPage())).toContain('href="/company/jobs/new"');
    const page = await html(NewJobPage());
    for (const label of ["Title", "Roles", "Work mode", "City", "Country", "Salary", "Apply URL", "Description", "Tags"]) {
      expect(page).toContain(`>${label}<`);
    }
    expect(page).toContain("Post on @nextcryptojob (reviewed by our team)");
    expect(page).toContain(">Publish<");
    expect(page).toContain(">Save draft<");
  });

  it("Publish creates a live job; the list shows it live with counts and its public page", async () => {
    const a = await company("Acme Labs");
    const id = await publish(a.co, { post_on_x: "on" });
    expect(rows("SELECT id FROM company_jobs_live")).toEqual([{ id }]);
    expect(rows("SELECT salary_min, salary_max, tags, x_post_state, created_via FROM company_jobs WHERE id = ?", id)).toEqual([
      { salary_min: 120000, salary_max: 150000, tags: '["DeFi","Solidity"]', x_post_state: "queued", created_via: "web" },
    ]);
    const list = await html(JobsPage(sp({ done: "job_published", job: id })));
    expect(list).toContain("Job published. It appears in daily digests of matching candidates.");
    expect(list).toContain(">Live<");
    expect(list).toContain("0 shown in digests, 0 clicks on Apply");
    expect(list).toContain("X post: waiting for our team");
    expect(list).toContain(`href="https://nextcryptojob.xyz/jobs/${id}"`);
    expect(list).toContain("1 of 10 open");
  });

  it("field problems come back next to the fields with what was typed", async () => {
    const a = await company("Acme Labs");
    const bad = await saveJobAction(
      EMPTY,
      jobForm(a.co, { roles: ["engineer", "bd", "trader", "finance"], salary_min: "lots", work_mode: [], title: "Go" }),
    );
    expect(bad.errors).toEqual({
      title: "Use 3 to 120 characters.",
      roles: "Choose 1 to 3 roles.",
      work_mode: "Choose Remote, City or both.",
      salary: "Use whole numbers, for example 120000.",
    });
    expect(bad.values?.salary_min).toBe("lots");
    // Помилки реєстру теж ідуть до своїх полів.
    const reg = await saveJobAction(EMPTY, jobForm(a.co, { apply_url: "http://acme.io", work_mode: ["city"] }));
    expect(reg.errors).toEqual({ apply_url: "Use an https:// link or a mailto: address.", city: "Add the city of the office." });
    expect(reg.message).toEqual({ tone: "error", text: "Check the fields above." });
    expect(rows("SELECT id FROM company_jobs")).toEqual([]);
  });

  it("a draft is saved without a link, then edited and published from its page; Close takes it out; Publish again reopens", async () => {
    const a = await company("Acme Labs");
    const url = await redirectOf(saveJobAction(EMPTY, jobForm(a.co, { intent: "draft", apply_url: "" })));
    expect(url).toMatch(/^\/company\/jobs\?done=job_draft&job=job_/);
    const id = new URL(url, "https://x").searchParams.get("job")!;
    const draft = await html(JobPage(jobPage(id)));
    expect(draft).toContain("Not live: Draft");
    expect(draft).toContain(">Publish<");

    const noLink = await saveJobAction(EMPTY, jobForm(a.co, { job_id: id, intent: "open", apply_url: "" }));
    expect(noLink.errors).toEqual({ apply_url: "Add an apply link (https:// or mailto:) to publish." });
    expect(await redirectOf(saveJobAction(EMPTY, jobForm(a.co, { job_id: id, intent: "open", title: "Senior Solidity engineer" })))).toBe(
      `/company/jobs?done=job_published&job=${id}`,
    );
    const open = await html(JobPage(jobPage(id)));
    expect(open).toContain("Live: in daily digests, the job search and on its public page.");
    expect(open).toContain(">Save changes<");
    expect(open).toContain('value="Senior Solidity engineer"');

    expect(await redirectOf(closeJobAction(form({ company_id: a.co, job_id: id, back: "job" })))).toBe(`/company/jobs/${id}?done=job_closed`);
    expect(rows("SELECT id FROM company_jobs_live")).toEqual([]);
    const closed = await html(JobPage(jobPage(id, { done: "job_closed" })));
    expect(closed).toContain("Job closed. It left the digests, the job search and the X queue.");
    expect(closed).toContain("Not live: Closed");
    expect(closed).toContain(">Publish again for 60 days<");
    expect(closed).not.toContain(">Close job<");
  });

  it("a job hidden by NextCryptoJob says so in the list", async () => {
    const a = await company("Acme Labs");
    const id = await publish(a.co);
    exec("UPDATE company_jobs SET hidden_by_admin_at = datetime('now') WHERE id = ?", id);
    expect(await html(JobsPage(sp()))).toContain("Not live: Hidden by NextCryptoJob");
  });

  it("without a subscription the screens are read-only and writes are refused", async () => {
    const a = await company("Acme Labs");
    const id = await publish(a.co);
    exec("UPDATE subscriptions SET status = 'canceled'");
    const list = await html(JobsPage(sp()));
    expect(list).toContain("Read-only: no active subscription.");
    expect(list).toContain("Not live: No active subscription");
    expect(list).not.toContain('href="/company/jobs/new"');
    expect(list).not.toContain(">Close job<");
    expect(await html(NewJobPage())).toContain("Subscribe to post jobs.");
    expect(await html(JobPage(jobPage(id)))).not.toContain(">Save changes<");
    const refused = await saveJobAction(EMPTY, jobForm(a.co));
    expect(refused.message?.text).toBe("This action needs a subscription.");
  });
});

describe("tenant isolation", () => {
  it("company B never sees company A's jobs and cannot edit or close them, even with the ids", async () => {
    const a = await company("Acme Labs");
    const id = await publish(a.co);
    const b = await company("Beta Labs");
    expect(await html(JobsPage(sp()))).not.toContain("Solidity engineer");
    await expect(JobPage(jobPage(id))).rejects.toThrow("NEXT_NOT_FOUND");
    const edit = await saveJobAction(EMPTY, jobForm(b.co, { job_id: id, title: "Taken over" }));
    expect(edit.message?.text).toBe("This job was not found.");
    expect(await redirectOf(closeJobAction(form({ company_id: b.co, job_id: id })))).toBe("/company/jobs?error=not_found");
    expect(rows("SELECT title, status FROM company_jobs WHERE id = ?", id)).toEqual([{ title: "Solidity engineer", status: "open" }]);
  });

  it("a form from a tab that shows company A is refused after switching to B", async () => {
    const a = await company("Acme Labs");
    const id = await publish(a.co);
    const b = addCompany(harness.raw, { name: "Beta Labs" });
    addSubscription(harness.raw, b);
    addMember(harness.raw, b, a.owner, "owner");
    harness.jar.set(COMPANY_COOKIE, b);
    const res = await saveJobAction(EMPTY, jobForm(a.co, { job_id: id, title: "Changed" }));
    expect(res.message?.tone).toBe("error");
    expect(await redirectOf(closeJobAction(form({ company_id: a.co, job_id: id })))).toBe("/company/jobs?error=company_switched");
    expect(rows("SELECT title, status FROM company_jobs WHERE id = ?", id)).toEqual([{ title: "Solidity engineer", status: "open" }]);
  });

  it("over the web burst limit job actions answer Too many actions and change nothing", async () => {
    const a = await company("Acme Labs");
    harness.env.RL_WEB = { limit: async () => ({ success: false }) } as unknown as RateLimit;
    const res = await saveJobAction(EMPTY, jobForm(a.co));
    expect(res.message?.text).toBe("Too many actions, wait a minute.");
    expect(rows("SELECT id FROM company_jobs")).toEqual([]);
  });
});
