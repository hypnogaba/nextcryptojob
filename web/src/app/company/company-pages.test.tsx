import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetSettingsCache } from "@/lib/admin/settings";
import { randomToken, sha256Hex } from "@/lib/auth/hash";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { COMPANY_COOKIE } from "@/lib/crm/context";
import { addCompany, addMember, addUser, crmDb } from "@/test/crm-fixtures";
import { exec, harness, RedirectCalled, resetHarness, rows } from "@/test/harness";
import AgencyApplicationsPage from "../admin/agency-applications/page";
import { reviewApplicationAction } from "../admin/agency-applications/actions";
import { switchCompanyAction } from "./(crm)/actions";
import { submitApplicationAction } from "./(crm)/apply/actions";
import ApplyPage from "./(crm)/apply/page";
import BillingPage from "./(crm)/billing/page";
import CrmLayout from "./(crm)/layout";
import SettingsPage from "./(crm)/settings/page";
import { closeCompanyAction, updateCompanySettingsAction } from "./(crm)/settings/actions";
import { inviteAction, leaveAction, removeMemberAction } from "./(crm)/team/actions";
import TeamPage from "./(crm)/team/page";
import { acceptInviteAction } from "./join/actions";
import JoinPage from "./join/page";
import { registerCompanyAction } from "./start/actions";
import StartPage from "./start/page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  usePathname: () => "/company/team",
  notFound: (): never => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

function setup() {
  resetSettingsCache();
  resetHarness();
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
  harness.headers = new Headers({ host: "nextcryptojob.xyz" });
}

async function signIn(email: string | null, o: { telegram?: string } = {}): Promise<string> {
  const existing = email ? rows<{ id: string }>("SELECT id FROM users WHERE email = ?", email)[0]?.id : undefined;
  const id = existing ?? addUser(harness.raw, { email, telegram: o.telegram ?? null });
  const token = randomToken();
  // Вхід поштою або Telegram (0013 sessions.method): адмінка пускає лише поштову сесію.
  exec(
    "INSERT INTO sessions (id, user_id, expires_at, method) VALUES (?, ?, datetime('now', '+1 day'), ?)",
    await sha256Hex(token),
    id,
    email ? "email" : "telegram",
  );
  harness.jar = (await import("@/test/harness")).fakeCookieJar();
  harness.jar.set(SESSION_COOKIE, token);
  return id;
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

async function redirectOf(p: Promise<unknown>): Promise<string> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RedirectCalled);
  return (err as RedirectCalled).url;
}

async function html(node: Promise<React.ReactNode> | React.ReactNode): Promise<string> {
  return renderToStaticMarkup(await node)
    .replaceAll("&quot;", '"')
    .replaceAll("&#x27;", "'")
    .replaceAll("&amp;", "&");
}

const params = (p: Record<string, string> = {}) => ({ searchParams: Promise.resolve(p) });

const COMPANY = { name: "Acme Labs", website: "acme.io", country: "FR", hiring_for: "own_team", terms: "on" };
const AGENCY = { name: "Hire Co", website: "hire.co", country: "GB", hiring_for: "agency", terms: "on" };
const APPLICATION = {
  contact_name: "Ann Lee",
  contact_email: "ann@hire.co",
  website: "hire.co",
  country: "GB",
  clients_text: "DeFi protocols in Europe.",
  volume_text: "3",
  data_use_text: "Only to contact candidates about client roles.",
  no_resale_ack: "on",
};

beforeEach(() => setup());
afterEach(() => vi.unstubAllEnvs());

describe("company registration", () => {
  it("our own team: active company, current-company cookie, then billing with the welcome paths", async () => {
    await signIn("dana@acme.io");
    expect(await redirectOf(registerCompanyAction({}, form(COMPANY)))).toBe("/company/billing?welcome=1");
    const [co] = rows<{ id: string; status: string }>("SELECT id, status FROM companies");
    expect(co.status).toBe("active");
    expect(harness.jar.get(COMPANY_COOKIE)?.value).toBe(co.id);

    const page = await html(BillingPage(params({ welcome: "1" })));
    expect(page).toContain("Your company is ready. Choose how to start.");
    expect(page).toContain("Pay 100 USDC for 30 days");
    expect(page).toContain("Continue with pay per request (API only)");
    const shell = await html(CrmLayout({ children: null }));
    expect(shell).toContain("Acme Labs");
    expect(shell).toContain("Team");
    expect(shell).not.toContain("Application received");
  });

  it("with company sign-ups closed: the start page says so instead of the form, the action creates nothing", async () => {
    exec("INSERT INTO app_settings (key, value_json) VALUES ('company_signups_open', 'false')");
    await signIn("dana@acme.io");
    const page = await html(StartPage(params()));
    expect(page).toContain("New company accounts are closed for now.");
    expect(page).not.toContain('name="website"');
    const state = await registerCompanyAction({}, form(COMPANY));
    expect(state.message).toEqual({ tone: "error", text: "New company accounts are closed for now. Try again later." });
    expect(rows("SELECT * FROM companies")).toEqual([]);
  });

  it("without the Company Terms nothing is created", async () => {
    await signIn("dana@acme.io");
    const state = await registerCompanyAction({}, form({ ...COMPANY, terms: "" }));
    expect(state.errors?.terms).toBe("Accept the Company Terms to continue.");
    expect(rows("SELECT * FROM companies")).toEqual([]);
  });
});

describe("agency: from application to access", () => {
  it("sees Application received, only settings are open, and after Approve it gets access", async () => {
    const ann = await signIn("ann@hire.co");
    expect(await redirectOf(registerCompanyAction({}, form(AGENCY)))).toBe("/company/apply");
    // До заявки: форма й плашка "Finish your agency application".
    expect(await html(ApplyPage())).toContain("Send application");
    expect(await html(CrmLayout({ children: null }))).toContain("Finish your agency application to get access.");

    const [{ id: agencyId }] = rows<{ id: string }>("SELECT id FROM companies");
    expect(await redirectOf(submitApplicationAction({}, form({ ...APPLICATION, company_id: agencyId })))).toBe("/company/apply");
    expect(await html(ApplyPage())).toContain("Application received.");
    const shell = await html(CrmLayout({ children: null }));
    expect(shell).toContain("Application received. We review applications within 2 business days.");
    expect(shell).not.toContain(">Team<");
    expect(shell).not.toContain(">Billing<");

    // Лише налаштування: інші сторінки CRM ведуть туди.
    expect(await redirectOf(TeamPage(params()))).toBe("/company/settings");
    expect(await redirectOf(BillingPage(params()))).toBe("/company/apply");
    expect(await html(SettingsPage())).toContain("Company settings");

    // Адмін схвалює.
    await signIn("hypnogaba@gmail.com");
    const queue = await html(AgencyApplicationsPage(params()));
    expect(queue).toContain("Hire Co");
    expect(queue).toContain("Ask for more info");
    const [app] = rows<{ id: string }>("SELECT id FROM agency_applications");
    const done = await redirectOf(reviewApplicationAction(form({ application_id: app.id, decision: "approve", note: "" })));
    expect(done).toBe(`/admin/agency-applications?done=approved&app=${app.id}&emailed=1`);
    expect(await html(AgencyApplicationsPage(params({ done: "approved", emailed: "1" })))).toContain("Approved. The agency has access now.");

    // Агенція знову: доступ є, плашки немає, команда відкрита.
    const token = randomToken();
    exec(
      "INSERT INTO sessions (id, user_id, expires_at, method) VALUES (?, ?, datetime('now', '+1 day'), 'email')",
      await sha256Hex(token),
      ann,
    );
    harness.jar.set(SESSION_COOKIE, token);
    const after = await html(CrmLayout({ children: null }));
    expect(after).not.toContain("Application received");
    expect(after).toContain(">Team<");
    expect(await html(TeamPage(params()))).toContain("Invite teammate");
  });

  it("the admin page is not there for others", async () => {
    await signIn("someone@acme.io");
    await expect(AgencyApplicationsPage(params())).rejects.toThrow("NEXT_NOT_FOUND");
    expect(await redirectOf(reviewApplicationAction(form({ application_id: "app_x", decision: "approve" })))).toBe(
      "/admin/agency-applications?error=not_admin",
    );
  });
});

describe("team pages", () => {
  async function companyWithOwner(): Promise<{ owner: string; companyId: string }> {
    const owner = await signIn("dana@acme.io");
    await redirectOf(registerCompanyAction({}, form(COMPANY)));
    const [{ id }] = rows<{ id: string }>("SELECT id FROM companies");
    return { owner, companyId: id };
  }

  it("without mail the owner gets the invite link; the invitee joins with the matching email only", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { companyId } = await companyWithOwner();
    const state = await inviteAction({}, form({ email: "lee@acme.io", company_id: companyId }));
    expect(state.message?.text).toBe("We could not email lee@acme.io. Copy the link below and send it yourself.");
    const link = state.link!;
    expect(link).toMatch(/^https:\/\/nextcryptojob\.xyz\/company\/join\?t=/);
    const t = new URL(link).searchParams.get("t")!;
    vi.unstubAllEnvs();

    // Не ввійшов.
    harness.jar = (await import("@/test/harness")).fakeCookieJar();
    expect(await html(JoinPage(params({ t })))).toContain("Sign in with l***@acme.io to accept.");
    // Інша пошта.
    await signIn("eve@acme.io");
    const wrong = await html(JoinPage(params({ t })));
    expect(wrong).toContain("This invite was sent to l***@acme.io.");
    expect(wrong).not.toContain("Join Acme Labs</button>");
    expect(await redirectOf(acceptInviteAction(form({ t })))).toBe(`/company/join?t=${t}&error=invite_email_mismatch`);
    // Та сама пошта.
    await signIn("lee@acme.io");
    expect(await html(JoinPage(params({ t })))).toContain("Join Acme Labs");
    expect(await redirectOf(acceptInviteAction(form({ t })))).toBe("/company/dashboard");
    expect(harness.jar.get(COMPANY_COOKIE)?.value).toBe(companyId);
    const team = await html(TeamPage(params()));
    expect(team).toContain("dana@acme.io");
    expect(team).toContain("lee@acme.io");
    // Член бачить команду, але не запрошує.
    expect(team).not.toContain("Invite teammate");
    // Посилання одноразове.
    expect(await html(JoinPage(params({ t })))).toContain("Invite not valid");
  });

  it("a removed member loses access on the next request", async () => {
    const { companyId } = await companyWithOwner();
    const lee = addUser(harness.raw, { email: "lee@acme.io" });
    addMember(harness.raw, companyId, lee, "member");
    const ownerJar = harness.jar;

    await signIn("lee@acme.io");
    expect(await html(TeamPage(params()))).toContain("People at Acme Labs");
    const leeJar = harness.jar;

    harness.jar = ownerJar;
    expect(await redirectOf(removeMemberAction(form({ user_id: lee, company_id: companyId })))).toBe("/company/team?done=removed");

    harness.jar = leeJar;
    expect(await redirectOf(TeamPage(params()))).toBe("/company/start");
  });

  it("the only owner cannot leave; the page says why", async () => {
    const { companyId } = await companyWithOwner();
    expect(await redirectOf(leaveAction(form({ company_id: companyId })))).toBe("/company/team?error=last_owner");
    expect(await html(TeamPage(params({ error: "last_owner" })))).toContain("Make someone else an owner or close the company first.");
  });
});

describe("company switcher", () => {
  it("switches only to companies of the person", async () => {
    const dana = await signIn("dana@acme.io");
    const a = addCompany(harness.raw, { name: "Acme" });
    const b = addCompany(harness.raw, { name: "Beta" });
    const other = addCompany(harness.raw, { name: "Not mine" });
    addMember(harness.raw, a, dana, "owner");
    addMember(harness.raw, b, dana, "member");

    expect(await redirectOf(switchCompanyAction(form({ company_id: b })))).toBe("/company/dashboard");
    expect(harness.jar.get(COMPANY_COOKIE)?.value).toBe(b);
    const shell = await html(CrmLayout({ children: null }));
    expect(shell).toContain("Beta");
    expect(shell).toContain("Switch company");

    await redirectOf(switchCompanyAction(form({ company_id: other })));
    expect(harness.jar.get(COMPANY_COOKIE)?.value).toBe(b);
    expect(await html(CrmLayout({ children: null }))).not.toContain("Not mine");
  });
});

describe("forms from a tab that shows another company", () => {
  async function twoCompanies() {
    const dana = await signIn("dana@acme.io");
    await redirectOf(registerCompanyAction({}, form(COMPANY)));
    await redirectOf(registerCompanyAction({}, form({ ...COMPANY, name: "Beta Labs", website: "beta.io" })));
    const ids = Object.fromEntries(rows<{ id: string; name: string }>("SELECT id, name FROM companies").map((r) => [r.name, r.id]));
    return { dana, a: ids["Acme Labs"], b: ids["Beta Labs"] };
  }

  it("tab 1 shows A, tab 2 switched to B: CLOSE in tab 1 is refused and closes nothing", async () => {
    const { a, b } = await twoCompanies();
    // Кукі вже на B (друга вкладка перемкнула), форма з першої вкладки несе A.
    expect(harness.jar.get(COMPANY_COOKIE)?.value).toBe(b);
    const state = await closeCompanyAction({}, form({ confirm: "CLOSE", company_id: a }));
    expect(state.message?.text).toBe("You switched company in another tab. Reload this page.");
    expect(rows("SELECT status FROM companies ORDER BY name")).toEqual([{ status: "active" }, { status: "active" }]);

    // Інші дії так само.
    expect((await inviteAction({}, form({ email: "lee@acme.io", company_id: a }))).error).toBe(
      "You switched company in another tab. Reload this page.",
    );
    expect(await redirectOf(leaveAction(form({ company_id: a })))).toBe("/company/team?error=company_switched");
    expect((await updateCompanySettingsAction({}, form({ ...COMPANY, company_id: a }))).message?.text).toBe(
      "You switched company in another tab. Reload this page.",
    );
    expect(rows("SELECT COUNT(*) AS n FROM company_members WHERE user_id IS NULL")).toEqual([{ n: 0 }]);

    // Форма з тієї самої компанії працює.
    expect(await redirectOf(closeCompanyAction({}, form({ confirm: "CLOSE", company_id: b })))).toBe("/company/settings");
    expect(rows<{ id: string; status: string }>("SELECT id, status FROM companies WHERE status = 'closed'").map((r) => r.id)).toEqual([b]);
  });

  it("after closing B the session is in A; a member of a closed company can leave it from settings", async () => {
    const { a, b } = await twoCompanies();
    await redirectOf(closeCompanyAction({}, form({ confirm: "CLOSE", company_id: b })));
    expect(await html(CrmLayout({ children: null }))).toContain("Acme Labs");

    // Кукі старої вкладки на B: однаково A.
    harness.jar.set(COMPANY_COOKIE, b);
    expect(await html(CrmLayout({ children: null }))).not.toContain("This company is closed.");

    // Лише закрита компанія: налаштування показують вихід.
    exec("DELETE FROM company_members WHERE company_id = ?", a);
    expect(await html(CrmLayout({ children: null }))).toContain("This company is closed.");
    expect(await html(SettingsPage())).toContain("Leave Beta Labs");
    expect(await redirectOf(leaveAction(form({ company_id: b, from: "settings" })))).toBe("/company/start");
    expect(rows("SELECT COUNT(*) AS n FROM company_members")).toEqual([{ n: 0 }]);
  });

  it("an expired session on Close company shows a message, not an error page", async () => {
    const { b } = await twoCompanies();
    harness.jar = (await import("@/test/harness")).fakeCookieJar();
    const state = await closeCompanyAction({}, form({ confirm: "CLOSE", company_id: b }));
    expect(state.message?.text).toBe("Sign in again to continue.");
  });
});
