import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSettings, resetSettingsCache } from "@/lib/admin/settings";
import { createSession } from "@/lib/auth/session";
import { exec, harness, RedirectCalled, resetHarness, rows } from "@/test/harness";
import { saveSettingsAction } from "./actions";
import AdminSettingsPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

class NotFoundCalled extends Error {}
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  notFound: (): never => {
    throw new NotFoundCalled("notFound()");
  },
}));

/**
 * /admin/settings: лише адмін, що ввійшов поштою; кожна зміна пише audit_log; секрети
 * Worker видно лише як «Set» чи «Missing», ніколи значенням.
 */

const SECRET = "sk_test_do_not_show_0123456789";

beforeEach(() => {
  resetSettingsCache();
  resetHarness({
    ADMIN_EMAILS: "boss@example.com",
    STRIPE_SECRET_KEY: SECRET,
    TELEGRAM_BOT_TOKEN: "123:bot-token-value",
    SITE_URL: "https://nextcryptojob.xyz",
  } as never);
  exec("INSERT INTO users (id, email, telegram_id) VALUES ('boss', 'boss@example.com', '555'), ('ada', 'ada@example.com', NULL)");
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function render(query: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await AdminSettingsPage({ searchParams: Promise.resolve(query) }));
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function redirectOf(p: Promise<unknown>): Promise<string> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RedirectCalled);
  return (err as RedirectCalled).url;
}

describe("/admin/settings access", () => {
  it("is not found for someone who is not an admin, or for an admin who came through Telegram", async () => {
    await createSession("ada", "email");
    await expect(render()).rejects.toBeInstanceOf(NotFoundCalled);
    await createSession("boss", "telegram");
    await expect(render()).rejects.toBeInstanceOf(NotFoundCalled);
  });

  it("refuses a save from anyone who is not an admin and writes nothing", async () => {
    await createSession("boss", "telegram");
    expect(await redirectOf(saveSettingsAction(form({ keys: "signups_open", signups_open: "false" })))).toBe(
      "/admin/settings?error=not_admin",
    );
    await createSession("ada", "email");
    expect(await redirectOf(saveSettingsAction(form({ keys: "signups_open", signups_open: "false" })))).toBe(
      "/admin/settings?error=not_admin",
    );
    expect(rows("SELECT key FROM app_settings")).toEqual([]);
    expect(rows("SELECT id FROM audit_log")).toEqual([]);
  });
});

describe("/admin/settings for an admin", () => {
  beforeEach(async () => {
    await createSession("boss", "email");
  });

  it("shows the editable settings with their defaults and the read-only configuration without secret values", async () => {
    const html = await render();
    expect(html).toContain('data-form="signups"');
    expect(html).toContain('data-form="notice"');
    expect(html).toMatch(/name="signups_open" checked="" value="true"/);
    expect(html).toContain("Default, never changed");
    // Секрети: лише «є» чи «немає».
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain("bot-token-value");
    expect(html).toMatch(/data-config="STRIPE_SECRET_KEY".*?>Set</);
    // «Немає» підписано тим, що це означає: картки вимкнені свідомо, робити нічого не треба.
    expect(html).toMatch(/data-config="STRIPE_WEBHOOK_SECRET".*?>Not set, and not needed</);
    expect(html).toContain("Card payments off. Companies pay by hand or in USDC");
    // Несекретні значення видно: хто адмін і адреса сайту.
    expect(html).toMatch(/data-config="ADMIN_EMAILS".*?boss@example.com/);
    expect(html).toMatch(/data-config="SITE_URL".*?https:\/\/nextcryptojob.xyz/);
    // Ключі рушія: жодної прогалини, тож замість таблиці нулів один рядок.
    expect(html).toContain('data-engine-keys="none"');
    expect(html).not.toContain("HELIUS_KEY");
    // Квоти й пробний строк лише для читання, під розкривкою.
    expect(html).toContain("Show the limits that live in code");
    expect(html).toContain("14 days");
    expect(html).toMatch(/Subscription<\/th><td[^>]*>300<\/td>/);
    expect(html).not.toMatch(/name="company_trial_days"/);
  });

  it("closes candidate sign-ups: one app_settings row, one audit row, the change applies at once", async () => {
    expect((await getSettings(harness.env.DB)).signups_open).toBe(true);
    const url = await redirectOf(
      saveSettingsAction(form({ keys: "signups_open,company_signups_open", signups_open: "false", company_signups_open: "true" })),
    );
    expect(url).toBe("/admin/settings?done=saved&changed=1");
    expect(rows("SELECT key, value_json, updated_by FROM app_settings")).toEqual([
      { key: "signups_open", value_json: "false", updated_by: "boss" },
    ]);
    expect(rows("SELECT actor, action, target, meta_json FROM audit_log")).toEqual([
      { actor: "admin:boss", action: "settings.update", target: "setting:signups_open", meta_json: '{"key":"signups_open","from":true,"to":false}' },
    ]);
    expect((await getSettings(harness.env.DB)).signups_open).toBe(false);

    const html = await render({ done: "saved", changed: "1" });
    expect(html).toContain("Saved 1 change.");
    expect(html).toMatch(/name="signups_open" checked="" value="false"/);
    expect(html).toMatch(/Changed <time/);
  });

  it("saves a notice and refuses one over 200 characters without writing", async () => {
    expect(
      await redirectOf(saveSettingsAction(form({ keys: "banner_message,banner_level", banner_message: "Digests are late today.", banner_level: "warning" }))),
    ).toBe("/admin/settings?done=saved&changed=2");
    expect(
      await redirectOf(saveSettingsAction(form({ keys: "banner_message,banner_level", banner_message: "x".repeat(201), banner_level: "info" }))),
    ).toBe("/admin/settings?error=banner_message");
    expect(rows("SELECT key, value_json FROM app_settings ORDER BY key")).toEqual([
      { key: "banner_level", value_json: '"warning"' },
      { key: "banner_message", value_json: '"Digests are late today."' },
    ]);
    expect(rows("SELECT id FROM audit_log")).toHaveLength(2);
    expect(await render({ error: "banner_message" })).toContain("Keep the notice under 200 characters.");
  });
});
