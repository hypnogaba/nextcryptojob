import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth/session";
import { exec, resetHarness } from "@/test/harness";
import SettingsPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);
// TelegramPanel лишається async Server Component (сама читає базу): renderToStaticMarkup
// (react-dom/server, не RSC-двигун Next) не вміє чекати вкладені async-компоненти. Тут не
// про Telegram, тож підміняємо на синхронний заглушку.
vi.mock("../account/telegram-panel", () => ({ TelegramPanel: () => null }));

beforeEach(() => {
  resetHarness();
  exec("INSERT INTO users (id, email, onboarding_step) VALUES ('u', 'ada@example.com', 'done')");
});

/** Рушій позначив, що бот не досягає людину (0027): сайт каже це прямо й веде до бота. */
describe("settings page when Telegram is not reachable", () => {
  it("shows the Start notice with the bot link, and clears it once the mark is gone", async () => {
    exec("UPDATE users SET telegram_id = '77', telegram_unreachable_at = datetime('now') WHERE id = 'u'");
    await createSession("u", null);
    const html = renderToStaticMarkup(await SettingsPage());
    expect(html).toContain("We can&#x27;t reach you on Telegram");
    expect(html).toContain('href="https://t.me/nextcryptojob_bot"');
    expect(html).toContain("press Start");

    exec("UPDATE users SET telegram_unreachable_at = NULL WHERE id = 'u'");
    expect(renderToStaticMarkup(await SettingsPage())).not.toContain("reach you on Telegram");
  });

  it("does not warn a person who never linked Telegram", async () => {
    exec("UPDATE users SET telegram_unreachable_at = datetime('now') WHERE id = 'u'");
    await createSession("u", null);
    expect(renderToStaticMarkup(await SettingsPage())).not.toContain("reach you on Telegram");
  });
});

/** Власник 16.09, п.1: створити компанію лишається на /company, не в кабінеті кандидата. */
describe("settings page has no 'create a company' option", () => {
  it("does not link to /company/start or mention a company account anywhere on the page", async () => {
    await createSession("u", null);
    const html = renderToStaticMarkup(await SettingsPage());
    expect(html).not.toContain('href="/company/start"');
    expect(html).not.toMatch(/Company account/i);
  });
});
