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

/** Власник 16.09, п.1: створити компанію лишається на /company, не в кабінеті кандидата. */
describe("settings page has no 'create a company' option", () => {
  it("does not link to /company/start or mention a company account anywhere on the page", async () => {
    await createSession("u", null);
    const html = renderToStaticMarkup(await SettingsPage());
    expect(html).not.toContain('href="/company/start"');
    expect(html).not.toMatch(/Company account/i);
  });
});
