import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth/session";
import { COMPANY_COOKIE } from "@/lib/crm/context";
import { exec, harness, RedirectCalled, resetHarness, rows } from "@/test/harness";
import { fakeEmail, stubNetwork, type Network } from "@/test/intro-fixtures";
import { createDemoAction, deleteDemoAction, openDemoAction, sendWeeklyNowAction } from "./actions";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

/** Дії головної адмінки: лише адмін (пошта з ADMIN_EMAILS і вхід поштою). */

let net: Network;

beforeEach(() => {
  net = stubNetwork();
  resetHarness({ ADMIN_EMAILS: "boss@example.com", TELEGRAM_BOT_TOKEN: "123:t", EMAIL: fakeEmail(net) } as never);
  exec("INSERT INTO users (id, email, telegram_id) VALUES ('boss', 'boss@example.com', '555')");
  exec("INSERT INTO users (id, email) VALUES ('ada', 'ada@example.com')");
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function redirectOf(p: Promise<unknown>): Promise<string> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RedirectCalled);
  return (err as RedirectCalled).url;
}

const form = (fields: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
};

describe("admin-only", () => {
  it("refuses everyone but an admin signed in by email, and changes nothing", async () => {
    for (const [user, method] of [["ada", "email"], ["boss", "telegram"]] as const) {
      await createSession(user, method);
      expect(await redirectOf(createDemoAction())).toBe("/admin/health?error=not_admin");
      expect(await redirectOf(deleteDemoAction())).toBe("/admin/health?error=not_admin");
      expect(await redirectOf(sendWeeklyNowAction())).toBe("/admin/health?error=not_admin");
      expect(await redirectOf(openDemoAction(form({ company_id: "co_x" })))).toBe("/admin/health?error=not_admin");
    }
    expect(rows("SELECT * FROM companies")).toEqual([]);
    expect(net.tg).toEqual([]);
    expect(net.mail).toEqual([]);
  });
});

describe("for the admin", () => {
  beforeEach(async () => {
    await createSession("boss", "email");
  });

  it("creates the demo company, opens it as the current company, and deletes all demo data", async () => {
    expect(await redirectOf(createDemoAction())).toBe("/admin/health?done=demo_created&n=12#demo");
    const [{ id }] = rows<{ id: string }>("SELECT id FROM companies WHERE is_demo = 1");
    expect(await redirectOf(openDemoAction(form({ company_id: id })))).toBe("/company/search");
    expect(harness.jar.get(COMPANY_COOKIE)?.value).toBe(id);
    expect(await redirectOf(deleteDemoAction())).toBe("/admin/health?done=demo_deleted&n=12&c=1#demo");
    expect(rows("SELECT COUNT(*) AS n FROM users WHERE is_demo = 1")).toEqual([{ n: 0 }]);
  });

  it("will not open a company that is not the admin's demo company", async () => {
    exec("INSERT INTO companies (id, name, terms_version, terms_accepted_at) VALUES ('co_real', 'Acme', 'v1', datetime('now'))");
    expect(await redirectOf(openDemoAction(form({ company_id: "co_real" })))).toBe("/admin/health?error=demo_missing#demo");
    expect(harness.jar.get(COMPANY_COOKIE)).toBeUndefined();
  });

  it("sends the weekly report now by Telegram and email", async () => {
    const url = await redirectOf(sendWeeklyNowAction());
    expect(url).toBe("/admin/health?done=weekly&ch=telegram%2Cemail#owner");
    expect(net.messagesTo("555")).toHaveLength(1);
    expect(net.mail.map((m) => m.to)).toEqual(["boss@example.com"]);
    expect(net.mail[0].subject).toMatch(/^NextCryptoJob weekly report, /);
  });
});
