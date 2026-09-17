import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth/session";
import { loadPrefs } from "@/lib/card/profile-prefs";
import { exec, harness, RedirectCalled, resetHarness, rows } from "@/test/harness";
import {
  addProofLinkAction,
  createApplyLinkAction,
  removeProofLinkAction,
  resetApplyLinkAction,
  setProofWalletAction,
  toggleProofItemAction,
} from "./proof-actions";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

const fd = (entries: Record<string, string>) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(entries)) f.set(k, v);
  return f;
};

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
  exec("INSERT INTO users (id, email) VALUES ('u', 'u@example.com'), ('v', 'v@example.com')");
  await createSession("u", null);
});

describe("proof actions", () => {
  it("hide and show a line for the signed-in person only, with an audit entry", async () => {
    expect(await run(toggleProofItemAction(fd({ item: "github.stars", hide: "1", user: "v" }))) ).toBe("/profile#proof");
    expect((await loadPrefs(harness.env.DB, "u")).hidden).toEqual(["github.stars"]);
    expect((await loadPrefs(harness.env.DB, "v")).hidden).toEqual([]);
    await run(toggleProofItemAction(fd({ item: "github.stars", hide: "0" })));
    expect((await loadPrefs(harness.env.DB, "u")).hidden).toEqual([]);
    expect(rows("SELECT action FROM audit_log WHERE actor = 'u' ORDER BY id").map((r) => r.action)).toEqual([
      "profile.hide",
      "profile.show",
    ]);
  });

  it("a bad link returns the error and keeps the input; a good one is saved and removable", async () => {
    const bad = await run(addProofLinkAction({}, fd({ label: "Talk", url: "http://ex.org" })));
    expect(bad).toEqual({ message: { tone: "error", text: "Use an https:// address." }, label: "Talk", url: "http://ex.org" });
    expect(await run(addProofLinkAction({}, fd({ label: "Talk", url: "https://ex.org/t" })))).toBe("/profile#proof");
    expect((await loadPrefs(harness.env.DB, "u")).links).toEqual([{ label: "Talk", url: "https://ex.org/t" }]);
    await run(removeProofLinkAction(fd({ index: "0" })));
    expect((await loadPrefs(harness.env.DB, "u")).links).toEqual([]);
    // Посилання не потрапляє в журнал.
    expect(JSON.stringify(rows("SELECT meta_json FROM audit_log"))).not.toContain("ex.org");
  });

  it("v7: a saved link queues a score update when the person agreed to scoring", async () => {
    exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('u', 'terms', 1, 'terms-0.2')");
    await run(addProofLinkAction({}, fd({ label: "Portfolio", url: "https://ex.org/p" })));
    expect(rows("SELECT reason, status FROM score_jobs WHERE user_id = 'u'")).toEqual([{ reason: "manual", status: "queued" }]);
    // Друге посилання поспіль: завдання вже чекає, нового не додаємо.
    await run(addProofLinkAction({}, fd({ label: "Talk", url: "https://ex.org/t" })));
    expect(rows("SELECT COUNT(*) AS n FROM score_jobs WHERE user_id = 'u'")).toEqual([{ n: 1 }]);
  });

  it("wallet addresses toggle, key create and reset", async () => {
    await run(setProofWalletAction(fd({ on: "1" })));
    expect((await loadPrefs(harness.env.DB, "u")).showWallet).toBe(true);
    await run(createApplyLinkAction());
    await run(createApplyLinkAction());
    expect((await loadPrefs(harness.env.DB, "u")).keyVersion).toBe(1);
    await run(resetApplyLinkAction());
    expect((await loadPrefs(harness.env.DB, "u")).keyVersion).toBe(2);
  });

  it("needs a session", async () => {
    resetHarness();
    await expect(run(createApplyLinkAction())).resolves.not.toBe("/profile#proof");
  });
});
