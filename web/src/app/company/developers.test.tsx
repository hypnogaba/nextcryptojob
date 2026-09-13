import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomToken, sha256Hex } from "@/lib/auth/hash";
import { SESSION_COOKIE } from "@/lib/auth/session";
import { COMPANY_COOKIE } from "@/lib/crm/context";
import { webhookSecret } from "@/lib/crm/webhooks";
import { addApiKey, addCompany, addMember, addSubscription, addUser, crmDb } from "@/test/crm-fixtures";
import { exec, fakeCookieJar, harness, RedirectCalled, resetHarness, rows } from "@/test/harness";
import { createKeyAction, revokeKeyAction, webhookAction, type CreateKeyState, type WebhookState } from "./(crm)/developers/actions";
import DevelopersPage from "./(crm)/developers/page";
import CrmLayout from "./(crm)/layout";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  usePathname: () => "/company/developers",
}));

/**
 * Сторінка Developers (W6): ключ API видно один раз і лише власнику, у базі лише
 * хеш; відкликати можна лише свій ключ; секрет вебхука лише у відповіді дії;
 * плашка "Your webhook is failing"; журнал доставок лише своєї компанії.
 */

const KEY = "test-webhook-signing-key-0123456789abcdef";

beforeEach(() => {
  resetHarness({ WEBHOOK_SIGNING_KEY: KEY } as never);
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
  harness.headers = new Headers({ host: "nextcryptojob.xyz" });
});

async function signIn(userId: string, companyId: string): Promise<void> {
  const token = randomToken();
  exec("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, datetime('now', '+1 day'))", await sha256Hex(token), userId);
  harness.jar = fakeCookieJar();
  harness.jar.set(SESSION_COOKIE, token);
  harness.jar.set(COMPANY_COOKIE, companyId);
}

function company(name: string): { co: string; owner: string } {
  const co = addCompany(harness.raw, { name });
  addSubscription(harness.raw, co);
  const owner = addUser(harness.raw, { email: `${name.toLowerCase().replace(/\s+/g, "")}@example.com`, visible: false });
  addMember(harness.raw, co, owner, "owner");
  return { co, owner };
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

async function html(node: Promise<React.ReactNode> | React.ReactNode): Promise<string> {
  return renderToStaticMarkup(await node).replaceAll("&quot;", '"').replaceAll("&#x27;", "'").replaceAll("&amp;", "&");
}

const page = () => html(DevelopersPage({ searchParams: Promise.resolve({}) }));

async function redirectOf(p: Promise<unknown>): Promise<string> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RedirectCalled);
  return (err as RedirectCalled).url;
}

describe("API keys", () => {
  it("the owner sees a new key once; the database and the page keep only its prefix and hash", async () => {
    const { co, owner } = company("Acme Labs");
    await signIn(owner, co);
    const state = await createKeyAction({} as CreateKeyState, form({ company_id: co, name: " sourcing-bot " }));
    const key = state.created?.key ?? "";
    expect(key).toMatch(/^ncj_live_[A-Za-z0-9]{43}$/);
    expect(state.created?.name).toBe("sourcing-bot");

    const [stored] = rows<{ prefix: string; key_hash: string; name: string }>("SELECT prefix, key_hash, name FROM api_keys WHERE company_id = ?", co);
    expect(stored).toEqual({ prefix: key.slice(0, 16), key_hash: await sha256Hex(key), name: "sourcing-bot" });
    expect(JSON.stringify(rows("SELECT * FROM api_keys")) + JSON.stringify(rows("SELECT * FROM audit_log"))).not.toContain(key);

    const shown = await page();
    expect(shown).toContain(key.slice(0, 16));
    expect(shown).not.toContain(key);
    expect(shown).toContain("sourcing-bot");
  });

  it("a member cannot see or create keys", async () => {
    const { co } = company("Acme Labs");
    await addApiKey(harness.raw, co, { name: "secret-bot" });
    const mia = addUser(harness.raw, { email: "mia@acme.io", visible: false });
    addMember(harness.raw, co, mia, "member");
    await signIn(mia, co);

    const shown = await page();
    expect(shown).toContain("Only the company owner can see, create and revoke API keys.");
    expect(shown).not.toContain("secret-bot");
    const state = await createKeyAction({} as CreateKeyState, form({ company_id: co, name: "mine" }));
    expect(state.created).toBeUndefined();
    expect(state.message).toEqual({ tone: "error", text: "Only the company owner can create API keys." });
    expect(rows("SELECT name FROM api_keys WHERE company_id = ?", co)).toEqual([{ name: "secret-bot" }]);
  });

  it("revokes only this company's keys", async () => {
    const a = company("Acme Labs");
    const b = company("Beta Corp");
    const mine = await addApiKey(harness.raw, a.co, { name: "mine" });
    const theirs = await addApiKey(harness.raw, b.co, { name: "theirs" });
    await signIn(a.owner, a.co);

    expect(await redirectOf(revokeKeyAction(form({ company_id: a.co, key_id: theirs.id })))).toBe("/company/developers?error=not_found#keys");
    expect(await redirectOf(revokeKeyAction(form({ company_id: b.co, key_id: mine.id })))).toBe("/company/developers?error=company_switched#keys");
    expect(rows("SELECT revoked_at FROM api_keys WHERE revoked_at IS NOT NULL")).toEqual([]);

    expect(await redirectOf(revokeKeyAction(form({ company_id: a.co, key_id: mine.id })))).toBe("/company/developers?done=revoked#keys");
    expect(rows<{ id: string }>("SELECT id FROM api_keys WHERE revoked_at IS NOT NULL").map((r) => r.id)).toEqual([mine.id]);
    expect(await page()).toContain("Revoked");
  });
});

describe("webhook", () => {
  it("returns the signing secret only in the answer to the save; the page never shows it", async () => {
    const { co, owner } = company("Acme Labs");
    await signIn(owner, co);
    const state = await webhookAction({} as WebhookState, form({ company_id: co, intent: "save", url: "https://hooks.acme.io/ncj", enabled: "on" }));
    expect(state.secret).toBe(await webhookSecret(KEY, co, 1));
    expect(state.message?.tone).toBe("success");
    const shown = await page();
    expect(shown).toContain("https://hooks.acme.io/ncj");
    expect(shown).not.toContain(state.secret);

    const again = await webhookAction({} as WebhookState, form({ company_id: co, intent: "save", url: "https://hooks.acme.io/v2", enabled: "on" }));
    expect(again.secret).toBeUndefined();
    const rotated = await webhookAction({} as WebhookState, form({ company_id: co, intent: "rotate" }));
    expect(rotated.secret).toBe(await webhookSecret(KEY, co, 2));
  });

  it("refuses a private URL with a field error", async () => {
    const { co, owner } = company("Acme Labs");
    await signIn(owner, co);
    const state = await webhookAction({} as WebhookState, form({ company_id: co, intent: "save", url: "https://10.0.0.1/hook", enabled: "on" }));
    expect(state.errors?.url).toContain("IP addresses");
    expect(rows("SELECT webhook_url FROM companies WHERE id = ?", co)).toEqual([{ webhook_url: null }]);
  });

  it("says webhooks are not available without the signing key", async () => {
    harness.env = { ...harness.env, WEBHOOK_SIGNING_KEY: undefined } as never;
    const { co, owner } = company("Acme Labs");
    await signIn(owner, co);
    const state = await webhookAction({} as WebhookState, form({ company_id: co, intent: "save", url: "https://hooks.acme.io/ncj" }));
    expect(state.message?.text).toContain("Webhooks are not available yet");
    expect(await page()).toContain("Webhooks are not available yet");
  });

  it("shows the failing banner and only this company's deliveries", async () => {
    const a = company("Acme Labs");
    const b = company("Beta Corp");
    exec("UPDATE companies SET webhook_url = 'https://hooks.acme.io/ncj', webhook_enabled = 1, webhook_failing_since = '2026-09-12 10:00:00' WHERE id = ?", a.co);
    const log = (co: string, eventId: string) =>
      exec(
        "INSERT INTO audit_log (actor, action, target, meta_json, at) VALUES (?, 'webhook.delivery', NULL, ?, '2026-09-12 09:00:00')",
        `${co}:webhook`,
        JSON.stringify({ company_id: co, event: "intro.accepted", event_id: eventId, attempt: 6, outcome: "failed", status_code: 500, error: "HTTP 500" }),
      );
    log(a.co, "evt_int_AAAAAAAAAAAAAAAAAAAA_accepted");
    log(b.co, "evt_int_BBBBBBBBBBBBBBBBBBBB_accepted");
    await signIn(a.owner, a.co);

    const shown = await page();
    expect(shown).toContain("Your webhook is failing");
    expect(shown).toContain("try 6 of 6: failed (HTTP 500)");
    expect(shown.match(/try 6 of 6/g)).toHaveLength(1);
    expect(await html(CrmLayout({ children: null }))).toContain("Your webhook is failing");

    await signIn(b.owner, b.co);
    expect(await html(CrmLayout({ children: null }))).not.toContain("Your webhook is failing");
  });
});
