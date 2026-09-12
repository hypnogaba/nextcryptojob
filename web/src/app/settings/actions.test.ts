import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, SESSION_COOKIE } from "@/lib/auth/session";
import { exec, harness, RedirectCalled, resetHarness, rows } from "@/test/harness";
import {
  deleteAccountAction,
  saveDailyJobsAction,
  setContactModeAction,
  setVisibilityAction,
} from "./actions";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

async function run(p: Promise<unknown>): Promise<unknown> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof RedirectCalled) return err.url;
    throw err;
  }
}

beforeEach(async () => {
  resetHarness();
  exec("INSERT INTO users (id, email, onboarding_step) VALUES ('u', 'u@example.com', 'done')");
  await createSession("u", null);
});

describe("settings actions need a session", () => {
  it("send a signed-out visitor to /login", async () => {
    harness.jar.delete(SESSION_COOKIE);
    await expect(run(setVisibilityAction({}, form({ visible: "on" })))).resolves.toBe("/login");
    await expect(run(deleteAccountAction({}, form({ confirm: "DELETE" })))).resolves.toBe("/login");
    expect(rows("SELECT id FROM users")).toEqual([{ id: "u" }]);
  });
});

describe("saveDailyJobsAction", () => {
  it("returns field errors and saves nothing for an hour out of range or an unknown zone", async () => {
    const res = await run(saveDailyJobsAction({}, form({ channel: "email", hour: "24", timezone: "Mars/Base" })));
    expect(res).toMatchObject({ errors: { hour: expect.any(String), timezone: expect.any(String) } });
    expect(rows("SELECT digest_hour, timezone FROM users")).toEqual([{ digest_hour: 7, timezone: null }]);
  });

  it("saves channel, hour, zone and the pause flag", async () => {
    const res = await run(
      saveDailyJobsAction({}, form({ channel: "email", hour: "9", timezone: "Europe/Paris", paused: "on" })),
    );
    expect(res).toMatchObject({ message: { tone: "success", text: "Saved. Daily jobs are paused." } });
    expect(rows("SELECT channel, digest_hour, timezone, digest_paused FROM users")).toEqual([
      { channel: "email", digest_hour: 9, timezone: "Europe/Paris", digest_paused: 1 },
    ]);
  });

  it("refuses Telegram without a linked Telegram", async () => {
    const res = await run(saveDailyJobsAction({}, form({ channel: "telegram", hour: "9", timezone: "UTC" })));
    expect(res).toMatchObject({ errors: { channel: "Connect Telegram first." } });
    expect(rows("SELECT channel FROM users")).toEqual([{ channel: "email" }]);
  });
});

describe("setVisibilityAction", () => {
  it("asks to finish setup without a scoring consent", async () => {
    await expect(run(setVisibilityAction({}, form({ visible: "on" })))).resolves.toMatchObject({
      message: { tone: "error" },
    });
    expect(rows("SELECT visible_to_companies AS v FROM users")).toEqual([{ v: 0 }]);
  });

  it("turns visibility on and off and logs both in the audit log", async () => {
    exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('u', 'scoring', 1, 'v1')");
    await run(setVisibilityAction({}, form({ visible: "on" })));
    expect(rows("SELECT visible_to_companies AS v FROM users")).toEqual([{ v: 1 }]);
    await run(setVisibilityAction({}, form({ visible: "off" })));
    expect(rows("SELECT visible_to_companies AS v FROM users")).toEqual([{ v: 0 }]);
    expect(rows("SELECT action, meta_json FROM audit_log ORDER BY id")).toEqual([
      { action: "consent.grant", meta_json: JSON.stringify({ kind: "visibility", version: "v1" }) },
      { action: "consent.revoke", meta_json: JSON.stringify({ kind: "visibility", version: "v1" }) },
    ]);
  });
});

describe("setContactModeAction", () => {
  it("refuses 'direct' without Telegram", async () => {
    await expect(run(setContactModeAction({}, form({ mode: "direct" })))).resolves.toMatchObject({
      errors: { mode: expect.any(String) },
    });
    expect(rows("SELECT contact_mode FROM users")).toEqual([{ contact_mode: "approval" }]);
    expect(rows("SELECT * FROM consents")).toEqual([]);
  });
});

describe("deleteAccountAction", () => {
  it("needs the word DELETE and deletes nothing without it", async () => {
    for (const confirm of ["", "delete", "DELETE ME"]) {
      await expect(run(deleteAccountAction({}, form({ confirm })))).resolves.toMatchObject({
        errors: { confirm: expect.any(String) },
      });
    }
    expect(rows("SELECT id FROM users")).toEqual([{ id: "u" }]);
  });

  it("deletes the account, signs out and goes home", async () => {
    exec("INSERT INTO identities (user_id, kind, value) VALUES ('u', 'x', 'ada')");
    await expect(run(deleteAccountAction({}, form({ confirm: "DELETE" })))).resolves.toBe("/");
    expect(rows("SELECT id FROM users")).toEqual([]);
    expect(rows("SELECT id FROM sessions")).toEqual([]);
    expect(rows("SELECT id FROM identities")).toEqual([]);
    expect(harness.jar.get(SESSION_COOKIE)).toBeUndefined();
  });
});
