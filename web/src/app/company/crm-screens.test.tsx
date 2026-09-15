import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken, sha256Hex } from "@/lib/auth/hash";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { COMPANY_COOKIE } from "@/lib/crm/context";
import { respondToIntro } from "@/lib/crm/intros";
import { NOT_REACHED_TEXT } from "@/lib/crm/notify";
import { candidateLabel } from "@/lib/crm/project";
import { addCompany, addMember, addScore, addSubscription, addUser, crmDb, publishFormula } from "@/test/crm-fixtures";
import { exec, fakeCookieJar, harness, RedirectCalled, resetHarness, rows } from "@/test/harness";
import { panelAction } from "./(crm)/candidates/[id]/actions";
import CandidatePage from "./(crm)/candidates/[id]/page";
import type { PanelState } from "./(crm)/candidates/[id]/panel-state";
import DashboardPage from "./(crm)/dashboard/page";
import CrmLayout from "./(crm)/layout";
import { moveCardAction, withdrawIntroAction } from "./(crm)/pipeline/actions";
import IntrosPage from "./(crm)/pipeline/intros/page";
import PipelinePage from "./(crm)/pipeline/page";
import { deleteSavedSearchAction, toggleAlertAction } from "./(crm)/saved-searches/actions";
import SavedSearchesPage from "./(crm)/saved-searches/page";
import { addFromSearchAction, loadMoreAction, saveSearchAction } from "./(crm)/search/actions";
import SearchPage from "./(crm)/search/page";
import { createDemo } from "@/lib/admin/demo";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  usePathname: () => "/company/dashboard",
  notFound: (): never => {
    throw new Error("NEXT_NOT_FOUND");
  },
}));

/**
 * Екрани CRM (T7) на справжній базі з усіма міграціями: дашборд, пошук, профіль
 * кандидата з панеллю картки і знайомством, воронка, знайомства, збережені пошуки.
 * Головне: компанія A ніколи не бачить воронки, нотаток і знайомств компанії B, а
 * контакт кандидата з'являється лише після «так».
 */

/** Нік і пошта кандидатів мають спільну частину: сторінка не може показати жодного з них до «так». */
const HANDLE_PART = "alice_eth";
const EMAIL_PART = ".private@gmail.com";
const handles = new Map<string, string>();
let seq = 0;

beforeEach(() => {
  resetHarness();
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
  harness.headers = new Headers({ host: "nextcryptojob.xyz" });
  publishFormula(raw);
});

async function signIn(userId: string, companyId?: string): Promise<void> {
  const token = randomToken();
  exec("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))", await sha256Hex(token), userId);
  harness.jar = fakeCookieJar();
  harness.jar.set(SESSION_COOKIE, token);
  if (companyId) harness.jar.set(COMPANY_COOKIE, companyId);
}

/** Компанія з власником (і підпискою, якщо не сказано інше); повертає id і вхід власника. */
async function company(name: string, o: { email?: string; subscribed?: boolean; kind?: string } = {}) {
  const co = addCompany(harness.raw, { name, kind: o.kind });
  if (o.subscribed ?? true) addSubscription(harness.raw, co);
  const owner = addUser(harness.raw, { email: o.email ?? `${name.toLowerCase().replace(/\s+/g, "")}@example.com`, visible: false });
  addMember(harness.raw, co, owner, "owner");
  const jar = async () => signIn(owner, co);
  await jar();
  return { co, owner, signIn: jar };
}

function candidate(score = 80, o: Parameters<typeof addUser>[1] = {}): string {
  seq++;
  const id = addUser(harness.raw, { email: `cand${seq}${EMAIL_PART}`, telegram: `${HANDLE_PART}${seq}`, ...o });
  handles.set(id, `@${HANDLE_PART}${seq}`);
  addScore(harness.raw, id, "engineer", score);
  return id;
}

function noContact(page: string): void {
  expect(page).not.toContain(HANDLE_PART);
  expect(page).not.toContain(EMAIL_PART);
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
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

const sp = (p: Record<string, string | string[]> = {}) => ({ searchParams: Promise.resolve(p) });
const cand = (id: string, p: Record<string, string> = {}) => ({ params: Promise.resolve({ id }), searchParams: Promise.resolve(p) });

const EMPTY: PanelState = { card: null, intro: null, history: [], introNotice: null, now: new Date().toISOString() };

async function panel(companyId: string, candidateId: string, op: string, extra: Record<string, string> = {}, prev = EMPTY) {
  return panelAction(prev, form({ company_id: companyId, candidate_id: candidateId, op, ...extra }));
}

const MESSAGE = "We are hiring a Solidity engineer for our lending protocol. Open to a 20 minute call?";

describe("shell and dashboard", () => {
  it("the menu has the CRM screens and a new company sees three first steps", async () => {
    await company("Acme Labs");
    const shell = await html(CrmLayout({ children: null }));
    for (const item of [">Dashboard<", ">Search<", ">Pipeline<", ">Saved searches<", ">Team<", ">Billing<", ">Settings<"]) {
      expect(shell).toContain(item);
    }
    const page = await html(DashboardPage());
    expect(page).toContain("1. Find candidates");
    expect(page).toContain("2. Save a search");
    expect(page).toContain("3. Post a job");
    expect(page).toContain("0/300");
    expect(page).toContain("0/40");
  });

  it("counts the pipeline, waiting intros and recent activity of this company only", async () => {
    const a = await company("Acme Labs");
    const x = candidate(81, { email: null });
    const y = candidate(70);
    await panel(a.co, y, "add");
    await panel(a.co, x, "intro", { message: MESSAGE });

    const page = await html(DashboardPage());
    expect(page).not.toContain("1. Find candidates");
    expect(page).toMatch(/Found<\/dt><dd[^>]*>1</);
    expect(page).toMatch(/Intro requested<\/dt><dd[^>]*>1</);
    expect(page).toContain(">1</span> pending");
    expect(page).toContain("expires in 14 days");
    expect(page).toContain(NOT_REACHED_TEXT);
    expect(page).toContain(`added ${candidateLabel(y)} to the pipeline`);
    expect(page).toContain(`requested an intro with ${candidateLabel(x)}`);
    expect(page).toContain("1/10");

    // Інша компанія бачить нулі й жодної події.
    await company("Beta Labs");
    const other = await html(DashboardPage());
    expect(other).toContain("1. Find candidates");
    expect(other).not.toContain(candidateLabel(x));
    expect(other).not.toContain(candidateLabel(y));
  });

  it("without a subscription the CRM is read-only: banner, no write controls, writes refused", async () => {
    const a = await company("Acme Labs", { subscribed: false });
    const shell = await html(CrmLayout({ children: null }));
    expect(shell).toContain("Read-only: no active subscription.");
    expect(shell).toContain("Go to billing");

    const x = candidate(81);
    const profile = await html(CandidatePage(cand(x)));
    expect(profile).toContain("Open-source engineering (GitHub)");
    expect(profile).not.toContain("Add to pipeline");
    expect(profile).not.toContain("Request intro");
    const refused = await panel(a.co, x, "add");
    expect(refused.error).toBe("Subscribe to do this in the web app, or use the API.");
    expect(rows("SELECT * FROM pipeline")).toEqual([]);
  });
});

describe("search", () => {
  it("does not search (or spend quota) until Search is pressed", async () => {
    await company("Acme Labs");
    candidate();
    const page = await html(SearchPage(sp({ role: "engineer" })));
    expect(page).toContain("choose filters and press Search.");
    expect(rows("SELECT * FROM usage_events")).toEqual([]);
  });

  it("shows anonymous results with scores and no contact, and writes one usage and audit row", async () => {
    const a = await company("Acme Labs");
    const x = candidate(81, { city: "Lisbon", remoteMode: "remote,city", salaryMin: 120000, salaryCurrency: "USD" });
    const page = await html(SearchPage(sp({ role: "engineer", q: "1" })));
    expect(page).toContain(candidateLabel(x));
    expect(page).toContain("Engineer 81");
    expect(page).toContain("Level 9");
    expect(page).toContain("Remote or Lisbon");
    expect(page).toContain("From 120,000 USD");
    expect(page).toContain("Contact after approval");
    expect(page).toContain("Add to pipeline");
    // Квота після цього пошуку.
    expect(page).toContain("Searches left today: 299 of 300");
    noContact(page);
    expect(rows("SELECT action, channel, company_id FROM usage_events")).toEqual([
      { action: "search_candidates", channel: "web", company_id: a.co },
    ]);
    expect(rows<{ action: string }>("SELECT action FROM audit_log WHERE action = 'candidate.search'")).toHaveLength(1);
  });

  it("role picker: one click on a role runs the search at once, spends exactly one search, best score first", async () => {
    await company("Acme Labs");
    const low = candidate(55);
    const high = candidate(91);
    const before = await html(SearchPage(sp()));
    // Кожна роль веде на пошук, що запускається одразу (q=1), без попереднього завантаження.
    expect(before).toContain('aria-label="I\'m hiring"');
    expect(before).toContain('href="/company/search?role=engineer&q=1"');
    expect(before).toContain('href="/company/search?role=bd&q=1"');
    expect(rows("SELECT * FROM usage_events")).toEqual([]);

    const page = await html(SearchPage(sp({ role: "engineer", q: "1" })));
    expect(rows("SELECT action FROM usage_events")).toEqual([{ action: "search_candidates" }]);
    expect(page).toContain("Best matches: Engineer");
    expect(page).toMatch(/aria-current="true"[^>]*>Engineer</);
    expect(page.indexOf(candidateLabel(high))).toBeLessThan(page.indexOf(candidateLabel(low)));
    // Фішка з балом, рівень, сильні сторони з розкладу балу, кнопка знайомства.
    expect(page).toContain("Level 10");
    expect(page).toMatch(/aria-label="Top signals"[^>]*>.*GitHub <b[^>]*>91<\/b>/);
    expect(page).toContain(`href="/company/candidates/${high}?role=engineer&intro=1"`);
    expect(page).toContain("Request intro");
    expect(page).toContain("if they accept you get their Telegram");
    noContact(page);
  });

  it("candidates who chose Telegram handle directly are marked, and their intro button says Show Telegram", async () => {
    await company("Acme Labs");
    candidate(70, { contactMode: "direct", contactConsent: true });
    candidate(60);
    const page = await html(SearchPage(sp({ role: "engineer", q: "1" })));
    expect(page.match(/data-contact="direct"/g)).toHaveLength(1);
    expect(page).toContain("Telegram handle directly");
    expect(page).toContain("Show Telegram");
    expect(page.match(/data-contact="approval"/g)).toHaveLength(1);
    noContact(page);
  });

  it("an empty result names the reason", async () => {
    await company("Acme Labs");
    candidate(40);
    const narrow = await html(SearchPage(sp({ role: "engineer", min_score: "90", q: "1" })));
    expect(narrow).toContain("No candidates match all filters. 1 visible candidate chose this role.");
    expect(narrow).toContain("Clear filters");
    const none = await html(SearchPage(sp({ role: "trader", q: "1" })));
    expect(none).toContain("No visible candidates chose this role yet. Save the search and we will email you when someone does.");
  });

  it("Load more brings the next page of the same search; Add to pipeline adds the card", async () => {
    const a = await company("Acme Labs");
    const ids = Array.from({ length: 25 }, (_, i) => candidate(50 + i));
    const page = await html(SearchPage(sp({ role: "engineer", q: "1" })));
    expect(page).toContain("20 candidates shown");
    expect(page).toContain("Load more");

    // Курсор тієї самої сторінки: беремо з першої сторінки через саму дію.
    const { runAction } = await import("@/lib/crm/actions");
    const { resolveWebActor } = await import("@/lib/crm/context");
    const first = (await runAction("search_candidates", { filters: { role: "engineer" } }, await resolveWebActor())).output as {
      next_cursor: string;
    };
    const more = await loadMoreAction({ companyId: a.co, query: "role=engineer", cursor: first.next_cursor });
    expect(more.ok).toBe(true);
    if (more.ok) expect(more.page.data).toHaveLength(5);

    const added = await addFromSearchAction({ companyId: a.co, candidateId: ids[0], role: "engineer" });
    expect(added).toEqual({ ok: true, stage: "found", tags: [] });
    expect(rows("SELECT user_id, stage, added_via FROM pipeline")).toEqual([{ user_id: ids[0], stage: "found", added_via: "web" }]);
  });

  it("Save search keeps the filters for the team; the list can switch the alert and delete it", async () => {
    const a = await company("Acme Labs");
    candidate(80);
    const saved = await saveSearchAction({}, form({ company_id: a.co, name: "Solidity, remote", query: "role=engineer&min_score=60&work=remote" }));
    expect(saved.message?.text).toBe("Saved. You get a daily email when new candidates match.");
    const list = await html(SavedSearchesPage(sp()));
    expect(list).toContain("Solidity, remote");
    expect(list).toContain("No alert yet.");
    expect(list).toContain("Engineer, score 60+, remote, by score");
    expect(list).toContain("/company/search?role=engineer&min_score=60&work=remote&q=1");

    const [{ id }] = rows<{ id: string }>("SELECT id FROM saved_searches");
    expect(await redirectOf(toggleAlertAction(form({ company_id: a.co, saved_search_id: id, alert: "off" })))).toBe(
      "/company/saved-searches?done=alert_off",
    );
    expect(rows("SELECT alert FROM saved_searches")).toEqual([{ alert: "off" }]);
    expect(await redirectOf(deleteSavedSearchAction(form({ company_id: a.co, saved_search_id: id })))).toBe(
      "/company/saved-searches?done=deleted",
    );
    expect(await html(SavedSearchesPage(sp()))).toContain("Save a search to get a daily email about new matches.");
  });

  it("without a subscription the web app does not search", async () => {
    await company("Acme Labs", { subscribed: false });
    candidate();
    const page = await html(SearchPage(sp({ role: "engineer", q: "1" })));
    expect(page).toContain("Searching in the web app needs a subscription.");
    expect(rows("SELECT * FROM usage_events")).toEqual([]);
  });
});

describe("candidate profile as a company sees it", () => {
  it("shows the score breakdown and badges, never the contact before an accepted intro", async () => {
    await company("Acme Labs");
    const x = candidate(81);
    const page = await html(CandidatePage(cand(x)));
    expect(page).toContain(candidateLabel(x));
    expect(page).toContain("Open-source engineering (GitHub)");
    expect(page).toContain("Reach and engagement on X");
    expect(page).toContain("How scores work");
    expect(page).toContain("Not in your pipeline yet.");
    expect(page).toContain("Request intro");
    expect(page).toContain("The candidate decides. They see your request, and if they accept, you get their Telegram");
    // Попередній перегляд у діалозі той самий, що отримає кандидат (notify.ts).
    expect(page).toContain("Acme Labs wants to talk to you about an Engineer role.");
    noContact(page);
    // Кожен показ профілю це один перегляд із квоти і рядок журналу; решта читань сторінки облік не пише.
    expect(rows("SELECT action FROM usage_events")).toEqual([{ action: "get_candidate" }]);
    expect(rows<{ action: string }>("SELECT action FROM audit_log WHERE action = 'candidate.view'")).toHaveLength(1);
  });

  it("notes, tags and stages go through the registry and come back without reloading the profile", async () => {
    const a = await company("Acme Labs");
    const x = candidate(81);
    let s = await panel(a.co, x, "add", { role: "engineer" });
    expect(s.message).toBe("Added to your pipeline.");
    expect(s.card?.stage).toBe("found");

    s = await panel(a.co, x, "note", { body: "Strong audits in lending protocols." }, s);
    expect(s.message).toBe("Note saved.");
    expect(s.history.map((e) => e.kind)).toEqual(["added", "note"]);
    expect(s.history[1].body).toBe("Strong audits in lending protocols.");

    s = await panel(a.co, x, "tag_add", { tag: "Solidity" }, s);
    s = await panel(a.co, x, "tag_add", { tag: "lending" }, s);
    s = await panel(a.co, x, "tag_add", { tag: "solidity" }, s);
    expect(s.card?.tags).toEqual(["Solidity", "lending"]);
    s = await panel(a.co, x, "tag_remove", { tag: "SOLIDITY" }, s);
    expect(s.card?.tags).toEqual(["lending"]);

    s = await panel(a.co, x, "move", { stage: "interview" }, s);
    expect(s.error).toBe("Contact is not shared yet. Request an intro first.");
    expect(s.card?.stage).toBe("found");
    s = await panel(a.co, x, "move", { stage: "declined" }, s);
    expect(s.card).toMatchObject({ stage: "declined", declined_by: "company" });

    // Сторінка показує той самий стан.
    const page = await html(CandidatePage(cand(x)));
    expect(page).toContain("Strong audits in lending protocols.");
    expect(page).toContain("lending");
    expect(page).toContain("Declined by company");
    expect(rows("SELECT action FROM audit_log WHERE action LIKE 'pipeline.%' ORDER BY id")).toEqual([
      { action: "pipeline.add" },
      { action: "pipeline.note" },
      { action: "pipeline.tags" },
      { action: "pipeline.tags" },
      { action: "pipeline.tags" },
      { action: "pipeline.stage" },
    ]);
    // Панель не рахує переглядів: лише сам показ сторінки; читання панелі облік не пишуть.
    expect(rows("SELECT action FROM usage_events WHERE action = 'get_candidate'")).toHaveLength(1);
    expect(rows("SELECT action FROM usage_events WHERE action LIKE 'list_%' OR action = 'get_account'")).toEqual([]);
  });

  it("request intro from the web: no x402, the card waits, the company sees when the candidate was not reached", async () => {
    const a = await company("Acme Labs");
    const x = candidate(81, { email: null });
    const short = await panel(a.co, x, "intro", { message: "Hi there" });
    expect(short.error).toBe("Some fields are not valid.");
    expect(short.fields?.message).toBeTruthy();

    const s = await panel(a.co, x, "intro", { message: MESSAGE, role: "engineer" });
    expect(s.message).toBe("Intro request sent. The candidate has 14 days to answer.");
    expect(s.card?.stage).toBe("intro_requested");
    expect(s.introNotice).toBe(NOT_REACHED_TEXT);
    expect(rows("SELECT requested_via, x402_payment_id, status, mode FROM intros")).toEqual([
      { requested_via: "web", x402_payment_id: null, status: "pending", mode: "approval" },
    ]);
    expect(rows("SELECT action, billing FROM usage_events WHERE action = 'request_intro'")).toEqual([
      { action: "request_intro", billing: "included" },
    ]);

    const page = await html(CandidatePage(cand(x)));
    expect(page).toContain("Intro requested. Expires in 14 days.");
    expect(page).toContain(NOT_REACHED_TEXT);
    expect(page).toContain("Withdraw request");
    noContact(page);

    const intros = await html(IntrosPage(sp()));
    expect(intros).toContain(candidateLabel(x));
    expect(intros).toContain("Waiting for answer");
    expect(intros).toContain(NOT_REACHED_TEXT);

    const [{ id }] = rows<{ id: string }>("SELECT id FROM intros");
    const back = await panel(a.co, x, "withdraw", { intro_id: id }, s);
    expect(back.message).toBe("Request withdrawn. The card is back in Found.");
    expect(back.card?.stage).toBe("found");
    expect(rows("SELECT status FROM intros")).toEqual([{ status: "canceled" }]);
  });

  it("the contact appears only after the candidate accepts", async () => {
    const a = await company("Acme Labs");
    const x = candidate(81);
    const handle = handles.get(x)!;
    await panel(a.co, x, "intro", { message: MESSAGE });
    noContact(await html(CandidatePage(cand(x))));
    noContact(await html(PipelinePage(sp())));
    noContact(await html(IntrosPage(sp())));

    const [{ id }] = rows<{ id: string }>("SELECT id FROM intros");
    const outcome = await respondToIntro(harness.env.DB as D1Database, {
      introId: id,
      userId: x,
      decision: "accept",
      via: "web",
      notifier: { mailer: null, origin: "https://nextcryptojob.xyz" },
    });
    expect(outcome.kind).toBe("accepted");

    const after = await html(CandidatePage(cand(x)));
    expect(after).toContain(handle);
    expect(after).toContain("after the candidate accepted your intro");
    expect(after).not.toContain(EMAIL_PART);
    expect(await html(PipelinePage(sp()))).toContain(handle);
    expect(await html(IntrosPage(sp({ status: "accepted" })))).toContain(handle);
  });

  it("direct mode: the Telegram handle and links show on the page at once (C4, owner 14.09)", async () => {
    const a = await company("Acme Labs");
    const x = candidate(81, { contactMode: "direct", contactConsent: true });
    const page = await html(CandidatePage(cand(x)));
    // Не потрібен запит: нік уже видно в картці Links, компанія не чекає на клік.
    expect(page).toContain(handles.get(x));
    expect(page).not.toContain("has not turned on");
    expect(page).toContain("Show Telegram handle");
    expect(page).toContain("This candidate shares their Telegram: message them directly.");
    expect(page).toContain("They will be told that Acme Labs viewed it.");

    // «Show Telegram handle» усе одно записує подію знайомства й журнал, як і раніше.
    const s = await panel(a.co, x, "intro", { message: "Hi, we found your profile on NextCryptoJob and would like to talk about a role." });
    expect(s.message).toBe("Here is the Telegram handle. The candidate was told that you viewed it.");
    expect(s.card?.contact?.value).toBe(handles.get(x));
    expect(rows("SELECT action FROM audit_log WHERE action = 'contact.reveal'")).toHaveLength(1);
  });

  it("opted out (approval mode): no links card contact, only after an accepted intro", async () => {
    const a = await company("Acme Labs");
    const x = candidate(81);
    const before = await html(CandidatePage(cand(x)));
    expect(before).toContain("has not turned on");
    noContact(before);

    await panel(a.co, x, "intro", { message: "Hi, we found your profile on NextCryptoJob and would like to talk about a role." });
    const [{ id: introId }] = rows<{ id: string }>("SELECT id FROM intros");
    await respondToIntro(harness.env.DB as D1Database, {
      introId,
      userId: x,
      decision: "accept",
      via: "web",
      notifier: { mailer: null, origin: "https://nextcryptojob.xyz" },
    });
    const after = await html(CandidatePage(cand(x)));
    // Прийнятий запит показує контакт у панелі, але не в картці Links: вона й далі порожня.
    expect(after).toContain("has not turned on");
    expect(after).toContain(handles.get(x));
  });

  it("the intro dialog says the candidate decides and you get their Telegram on yes; ?intro=1 opens it", async () => {
    await company("Acme Labs");
    const x = candidate(81);
    const page = await html(CandidatePage(cand(x, { intro: "1" })));
    expect(page).toContain("The candidate decides. They see your request, and if they accept, you get their Telegram.");
    expect(page).toContain('data-contact-rule="approval"');
    noContact(page);
  });

  it("a hidden candidate keeps only own notes, history and a shared contact", async () => {
    const a = await company("Acme Labs");
    const x = candidate(81);
    await panel(a.co, x, "add");
    await panel(a.co, x, "note", { body: "Met at ETHLisbon." });
    exec("UPDATE users SET visible_to_companies = 0 WHERE id = ?", x);
    const page = await html(CandidatePage(cand(x)));
    expect(page).toContain("Candidate is no longer visible");
    expect(page).toContain("Met at ETHLisbon.");
    expect(page).not.toContain("Open-source engineering (GitHub)");
    expect(page).not.toContain("Request intro");

    const stranger = candidate(81);
    exec("UPDATE users SET visible_to_companies = 0 WHERE id = ?", stranger);
    expect(await html(CandidatePage(cand(stranger)))).toContain("This candidate is not available.");
  });
});

describe("pipeline board and list", () => {
  it("six stages, Move to... and Withdraw go through the registry and come back to the same view", async () => {
    const a = await company("Acme Labs");
    const x = candidate(81, { email: null });
    const y = candidate(72);
    await panel(a.co, y, "add");
    await panel(a.co, y, "tag_add", { tag: "solidity" });
    await panel(a.co, x, "intro", { message: MESSAGE });

    const board = await html(PipelinePage(sp()));
    for (const stage of ["Found (1)", "Intro requested (1)", "Contact shared (0)", "Interview (0)", "Hired (0)", "Declined (0)"]) {
      expect(board).toContain(stage);
    }
    expect(board).toContain("Engineer 72");
    expect(board).toContain("solidity");
    expect(board).toContain("Expires in 14 days");
    expect(board).toContain("Withdraw");

    expect(await redirectOf(moveCardAction(form({ company_id: a.co, candidate_id: y, stage: "hired" })))).toBe(
      "/company/pipeline?error=contact_not_shared",
    );
    expect(await html(PipelinePage(sp({ error: "contact_not_shared" })))).toContain("Contact is not shared yet. Request an intro first.");
    expect(await redirectOf(moveCardAction(form({ company_id: a.co, candidate_id: y, stage: "declined", view: "list" })))).toBe(
      "/company/pipeline?view=list&done=moved",
    );
    const list = await html(PipelinePage(sp({ view: "list", done: "moved" })));
    expect(list).toContain("Card moved.");
    expect(list).toContain("Declined by company");

    const [{ id }] = rows<{ id: string }>("SELECT id FROM intros");
    expect(await redirectOf(withdrawIntroAction(form({ company_id: a.co, intro_id: id, from: "intros" })))).toBe(
      "/company/pipeline/intros?done=withdrawn",
    );
    expect(rows("SELECT stage FROM pipeline WHERE user_id = ?", x)).toEqual([{ stage: "found" }]);

    // Фільтр тегу.
    const tagged = await html(PipelinePage(sp({ view: "list", tag: "SOLIDITY" })));
    expect(tagged).toContain(candidateLabel(y));
    expect(tagged).not.toContain(candidateLabel(x));
  });

  it("an empty pipeline says where to find candidates", async () => {
    await company("Acme Labs");
    expect(await html(PipelinePage(sp()))).toContain("Your pipeline is empty. Find candidates in Search and add them here.");
  });
});

describe("tags under concurrency", () => {
  it("tags added from two tabs both stay, a case repeat is ignored, removing one keeps the others", async () => {
    const a = await company("Acme Labs");
    const x = candidate(81);
    await panel(a.co, x, "add");
    await Promise.all([panel(a.co, x, "tag_add", { tag: "solidity" }), panel(a.co, x, "tag_add", { tag: "lending" })]);
    const [{ tags }] = rows<{ tags: string }>("SELECT tags FROM pipeline");
    expect(JSON.parse(tags).sort()).toEqual(["lending", "solidity"]);
    // Той самий тег іншим регістром удруге не додається; подія й журнал лише на справжні зміни.
    await Promise.all([panel(a.co, x, "tag_add", { tag: "Rust" }), panel(a.co, x, "tag_add", { tag: "RUST" })]);
    expect(JSON.parse(rows<{ tags: string }>("SELECT tags FROM pipeline")[0].tags)).toHaveLength(3);
    await Promise.all([panel(a.co, x, "tag_remove", { tag: "SOLIDITY" }), panel(a.co, x, "tag_add", { tag: "defi" })]);
    const after = JSON.parse(rows<{ tags: string }>("SELECT tags FROM pipeline")[0].tags) as string[];
    expect(after.map((t) => t.toLowerCase()).sort()).toEqual(["defi", "lending", "rust"]);
    expect(rows("SELECT COUNT(*) AS n FROM pipeline_events WHERE kind = 'tags_changed'")).toEqual([{ n: 5 }]);
    expect(rows("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'pipeline.tags'")).toEqual([{ n: 5 }]);
    const [last] = rows<{ meta_json: string }>("SELECT meta_json FROM audit_log WHERE action = 'pipeline.tags' ORDER BY id DESC LIMIT 1");
    expect(JSON.parse(last.meta_json).tag_count).toBe(3);
  });

  it("the eleventh tag is refused with a field message", async () => {
    const a = await company("Acme Labs");
    const x = candidate(81);
    await panel(a.co, x, "add");
    for (let i = 0; i < 10; i++) await panel(a.co, x, "tag_add", { tag: `t${i}` });
    const s = await panel(a.co, x, "tag_add", { tag: "eleven" });
    expect(s.fields?.tags).toBe("Use at most 10 tags.");
    expect(JSON.parse(rows<{ tags: string }>("SELECT tags FROM pipeline")[0].tags)).toHaveLength(10);
  });
});

describe("burst limit for web actions (RL_WEB)", () => {
  it("over the limit every CRM action answers Too many actions, wait a minute. and changes nothing", async () => {
    const a = await company("Acme Labs");
    const x = candidate(81);
    const counts = new Map<string, number>();
    // Як Workers Rate Limiting: ключ на людину, межа 2 (у проді 120 на хвилину).
    harness.env.RL_WEB = {
      limit: async ({ key }: { key: string }) => {
        counts.set(key, (counts.get(key) ?? 0) + 1);
        return { success: (counts.get(key) ?? 0) <= 2 };
      },
    } as unknown as RateLimit;
    expect((await panel(a.co, x, "add")).card?.stage).toBe("found");
    expect((await panel(a.co, x, "note", { body: "One" })).message).toBe("Note saved.");

    const busy = "Too many actions, wait a minute.";
    expect((await panel(a.co, x, "note", { body: "Two" })).error).toBe(busy);
    expect(await addFromSearchAction({ companyId: a.co, candidateId: candidate(70) })).toEqual({ ok: false, error: busy });
    expect((await saveSearchAction({}, form({ company_id: a.co, name: "S", query: "" }))).error).toBe(busy);
    expect(await redirectOf(moveCardAction(form({ company_id: a.co, candidate_id: x, stage: "declined" })))).toBe(
      "/company/pipeline?error=rate_limited",
    );
    expect(await html(PipelinePage(sp({ error: "rate_limited" })))).toContain(busy);
    const { inviteAction } = await import("./(crm)/team/actions");
    expect((await inviteAction({}, form({ company_id: a.co, email: "lee@acme.io" }))).error).toBe(busy);
    const { updateCompanySettingsAction } = await import("./(crm)/settings/actions");
    const settings = await updateCompanySettingsAction({}, form({ company_id: a.co, name: "Acme", website: "acme.io", country: "FR" }));
    expect(settings.message?.text).toBe(busy);
    expect(rows("SELECT note_count, stage FROM pipeline WHERE user_id = ?", x)).toEqual([{ note_count: 1, stage: "found" }]);
    expect(rows("SELECT * FROM saved_searches")).toEqual([]);
    expect([...counts.keys()]).toEqual([`user:${a.owner}`]);

    // Інша людина має свій лічильник.
    const b = await company("Beta Labs");
    expect((await panel(b.co, x, "add")).card?.stage).toBe("found");
  });
});

describe("search actions refuse malformed input with a readable error", () => {
  it("null, wrong types or a bad candidate id", async () => {
    await company("Acme Labs");
    const bad = "This request is not valid. Reload the page and try again.";
    expect(await loadMoreAction(null as never)).toEqual({ ok: false, error: bad });
    expect(await loadMoreAction({ companyId: "x", query: 5, cursor: "" } as never)).toEqual({ ok: false, error: bad });
    expect(await addFromSearchAction(null as never)).toEqual({ ok: false, error: bad });
    expect(await addFromSearchAction({ companyId: "co_x", candidateId: "not-a-uuid" })).toEqual({ ok: false, error: bad });
  });
});

describe("tenant isolation", () => {
  async function aWithData() {
    const a = await company("Acme Labs");
    const x = candidate(81, { email: null });
    await panel(a.co, x, "add");
    await panel(a.co, x, "note", { body: "Acme secret note" });
    await panel(a.co, x, "tag_add", { tag: "acme-tag" });
    await panel(a.co, x, "intro", { message: MESSAGE });
    const [{ id: introId }] = rows<{ id: string }>("SELECT id FROM intros");
    await html(SearchPage(sp({ role: "engineer", q: "1" })));
    return { a, x, introId };
  }

  it("company B never sees company A's pipeline, notes, tags or intros", async () => {
    const { x } = await aWithData();
    const b = await company("Beta Labs");

    const profile = await html(CandidatePage(cand(x)));
    expect(profile).toContain(candidateLabel(x));
    expect(profile).toContain("Not in your pipeline yet.");
    expect(profile).not.toContain("Acme secret note");
    expect(profile).not.toContain("acme-tag");
    expect(profile).not.toContain("Intro requested");
    expect(profile).not.toContain(NOT_REACHED_TEXT);

    expect(await html(PipelinePage(sp()))).toContain("Your pipeline is empty.");
    const list = await html(PipelinePage(sp({ view: "list", tag: "acme-tag" })));
    expect(list).not.toContain(candidateLabel(x));
    expect(await html(IntrosPage(sp()))).toContain("No intros yet.");
    expect(await html(SavedSearchesPage(sp()))).toContain("Save a search");
    const dash = await html(DashboardPage());
    expect(dash).not.toContain(candidateLabel(x));

    // Пошук B показує кандидата без етапу A.
    const search = await html(SearchPage(sp({ role: "engineer", q: "1" })));
    expect(search).toContain("Add to pipeline");
    expect(search).not.toContain("In pipeline");
    expect(rows("SELECT COUNT(*) AS n FROM pipeline WHERE company_id = ?", b.co)).toEqual([{ n: 0 }]);
  });

  it("company B cannot change A's card or withdraw A's intro, even with the ids", async () => {
    const { a, x, introId } = await aWithData();
    const b = await company("Beta Labs");

    const note = await panel(b.co, x, "note", { body: "B writes here" });
    expect(note.error).toBe("This candidate is not in your pipeline.");
    const move = await panel(b.co, x, "move", { stage: "declined" });
    expect(move.error).toBe("This candidate is not in your pipeline.");
    const withdraw = await panel(b.co, x, "withdraw", { intro_id: introId });
    expect(withdraw.error).toBe("This intro was not found.");
    expect(await redirectOf(withdrawIntroAction(form({ company_id: b.co, intro_id: introId })))).toBe("/company/pipeline?error=not_found");

    expect(rows("SELECT company_id, stage, note_count, tags FROM pipeline")).toEqual([
      { company_id: a.co, stage: "intro_requested", note_count: 1, tags: '["acme-tag"]' },
    ]);
    expect(rows("SELECT status FROM intros")).toEqual([{ status: "pending" }]);
  });

  it("a form from a tab that shows company A is refused after switching to B in another tab", async () => {
    const a = await company("Acme Labs");
    const x = candidate(81);
    const b = addCompany(harness.raw, { name: "Beta Labs" });
    addSubscription(harness.raw, b);
    addMember(harness.raw, b, a.owner, "owner");
    harness.jar.set(COMPANY_COOKIE, b);

    const switched = "You switched company in another tab. Reload this page.";
    expect((await panel(a.co, x, "add")).error).toBe(switched);
    expect(await addFromSearchAction({ companyId: a.co, candidateId: x })).toEqual({ ok: false, error: switched });
    expect((await saveSearchAction({}, form({ company_id: a.co, name: "S", query: "" }))).error).toBe(switched);
    expect(await redirectOf(moveCardAction(form({ company_id: a.co, candidate_id: x, stage: "declined" })))).toBe(
      "/company/pipeline?error=company_switched",
    );
    expect(rows("SELECT * FROM pipeline")).toEqual([]);
    expect(rows("SELECT * FROM saved_searches")).toEqual([]);

    // Та сама вкладка з B працює і пише в B.
    expect((await panel(b, x, "add")).card?.stage).toBe("found");
    expect(rows("SELECT company_id FROM pipeline")).toEqual([{ company_id: b }]);
  });
});

describe("demo company", () => {
  async function demo() {
    const admin = addUser(harness.raw, { email: "boss@example.com", visible: false });
    const { companyId } = await createDemo(harness.env.DB, admin);
    await signIn(admin, companyId);
    const ids = rows<{ id: string }>("SELECT id FROM users WHERE is_demo = 1 ORDER BY id").map((r) => r.id);
    return { admin, companyId, ids, idOf: (n: number) => ids.find((id) => id.startsWith(`de00${String(n).padStart(2, "0")}`))! };
  }

  it("says it is a demo in the CRM shell, and its search shows only synthetic candidates", async () => {
    const real = candidate(99);
    const d = await demo();
    const shell = await html(CrmLayout({ children: null }));
    expect(shell).toContain("data-demo-banner");
    expect(shell).toContain("Every candidate here is synthetic");
    const page = await html(SearchPage(sp({ role: "engineer", q: "1" })));
    expect(page).toContain("#DE0001");
    expect(page).not.toContain(candidateLabel(real));
    expect(d.ids).toHaveLength(12);
  });

  it("an intro to a demo candidate waits, then Simulate accept shows the demo Telegram handle", async () => {
    const d = await demo();
    const x = d.idOf(2);
    const sent = await panel(d.companyId, x, "intro", { message: MESSAGE });
    expect(sent.error).toBeUndefined();
    expect(sent.intro?.status).toBe("pending");
    const page = await html(CandidatePage(cand(x)));
    expect(page).toContain("Simulate accept");
    expect(page).toContain("Simulate decline");
    const answered = await panel(d.companyId, x, "demo_accept", { intro_id: sent.intro!.intro_id });
    expect(answered.message).toBe("Demo: the candidate accepted. Their Telegram handle is below.");
    expect(answered.card?.contact?.value).toBe("@ncj-demo-02");
  });

  it("a real company cannot use the demo answer", async () => {
    const a = await company("Acme Labs");
    const x = candidate(81);
    const sent = await panel(a.co, x, "intro", { message: MESSAGE });
    const refused = await panel(a.co, x, "demo_accept", { intro_id: sent.intro!.intro_id });
    expect(refused.error).toBe("Only a demo company can answer for a demo candidate.");
    expect(rows("SELECT status FROM intros")).toEqual([{ status: "pending" }]);
  });
});
