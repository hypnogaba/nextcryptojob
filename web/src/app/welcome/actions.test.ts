import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth/session";
import { claimCode } from "@/lib/verify/claim";
import { exec, fakeCookieJar, harness, RedirectCalled, resetHarness, rows, TEST_SECRET } from "@/test/harness";
import { saveRolesAction } from "./actions/answers";
import { finishAction } from "./actions/finish";
import { saveSourcesAction } from "./actions/sources";
import { checkCodeAction } from "./actions/verify";
import { saveWalletsAction } from "./actions/wallets";
import { claimXAction, continueXAction } from "./actions/x";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

const EVM = "0xe6b532e63f228087e26a5897131f2e1d043e27f2";

function form(fields: Record<string, string | string[]>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) for (const one of [v].flat()) data.append(k, one);
  return data;
}

/** Виклик дії; повертає адресу redirect або стан форми. */
async function run<T>(p: Promise<T>): Promise<string | T> {
  try {
    return await p;
  } catch (err) {
    if (err instanceof RedirectCalled) return err.url;
    throw err;
  }
}

/** Людина на кроці `step` з ролями `roles` і власною сесією (кука в новій банці). */
async function signInAt(id: string, step: string | null, roles = "[]") {
  exec("INSERT INTO users (id, email, onboarding_step, roles) VALUES (?, ?, ?, ?)", id, `${id}@example.com`, step, roles);
  harness.jar = fakeCookieJar();
  await createSession(id);
}

beforeEach(() => {
  resetHarness({ TWITTER_TOKEN: "tok" } as never);
  // Ключ з оболонки розробника не має потрапити в тест, а мережа не має бути справжньою.
  vi.stubEnv("TWITTER_TOKEN", "");
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("unexpected network call");
  }));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("step guards", () => {
  it("sends a person back when they post a step they have not reached", async () => {
    await signInAt("u", "target");
    await expect(run(saveWalletsAction({}, form({ wallets: EVM })))).resolves.toBe("/welcome");
    await expect(run(saveSourcesAction({}, form({ github: "ada" })))).resolves.toBe("/welcome");
    await expect(run(continueXAction())).resolves.toBe("/welcome");
    await expect(run(finishAction({}, form({ agree: "yes" })))).resolves.toBe("/welcome");
    expect(rows("SELECT * FROM identities")).toEqual([]);
    expect(rows("SELECT * FROM consents")).toEqual([]);
    expect(rows("SELECT onboarding_step FROM users")).toEqual([{ onboarding_step: "target" }]);
  });

  it("lets a person save the step they are on and moves them forward", async () => {
    await signInAt("u", "wallets");
    await expect(run(saveWalletsAction({}, form({ wallets: EVM })))).resolves.toBe("/welcome?step=sources");
    expect(rows("SELECT kind, value FROM identities")).toEqual([{ kind: "evm", value: EVM }]);
    expect(rows("SELECT onboarding_step FROM users")).toEqual([{ onboarding_step: "sources" }]);
  });

  it("does not finish without roles", async () => {
    await signInAt("u", "consent");
    await expect(run(finishAction({}, form({ agree: "yes" })))).resolves.toBe("/welcome?step=roles");
    expect(rows("SELECT * FROM score_jobs")).toEqual([]);
  });

  it("sends a visitor without a session to sign in", async () => {
    await expect(run(saveRolesAction({}, form({ role: "bd" })))).resolves.toBe("/login");
  });
});

describe("claiming an X handle from an unverified squatter", () => {
  it("offers a claim code, then moves the handle on a found code", async () => {
    await signInAt("squatter", "x");
    await expect(run(claimXAction({}, form({ handle: "ada" })))).resolves.toBe("/welcome?step=x");
    await signInAt("owner", "x");
    await expect(run(claimXAction({}, form({ handle: "@Ada" })))).resolves.toBe("/welcome?step=x&claim=ada");

    const code = await claimCode(TEST_SECRET, "x", "ada", "owner");
    vi.stubGlobal("fetch", vi.fn(async () =>
      new Response(JSON.stringify({ data: { screenName: "ada", description: `me ${code}` } })),
    ));
    await expect(run(checkCodeAction({}, form({ kind: "x", claim: "ada" })))).resolves.toBe("/welcome?step=x");
    expect(rows("SELECT user_id, value, verified_via FROM identities WHERE kind = 'x'")).toEqual([
      { user_id: "owner", value: "ada", verified_via: "bio_code" },
    ]);
  });

  it("says the code is missing when it is not there, and moves nothing", async () => {
    await signInAt("squatter", "x");
    await run(claimXAction({}, form({ handle: "ada" })));
    await signInAt("owner", "x");
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      new Response(JSON.stringify(
        String(url).endsWith("twitter_user_info")
          ? { data: { screenName: "ada", description: "nope" } }
          : { data: [{ id: "1", conversationId: "1", text: "gm", userScreenName: "ada" }] },
      )),
    ));
    const state = await run(checkCodeAction({}, form({ kind: "x", claim: "ada" })));
    expect(state).toMatchObject({ message: { tone: "error", text: expect.stringContaining("Retweets do not count") } });
    expect(rows("SELECT user_id FROM identities WHERE kind = 'x'")).toEqual([{ user_id: "squatter" }]);
  });
});

describe("rescoring after a finished person changes sources", () => {
  it("shows the wait time when the last job is less than a minute old", async () => {
    await signInAt("u", "done", '["trader"]');
    exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('u', 'scoring', 1, 'v1')");
    exec(
      "INSERT INTO score_jobs (user_id, reason, status, queued_at, started_at) " +
        "VALUES ('u', 'connect', 'done', datetime('now', '-20 seconds'), datetime('now', '-10 seconds'))",
    );
    const url = await run(saveWalletsAction({}, form({ wallets: EVM })));
    expect(url).toMatch(/^\/profile\?wait=\d+$/);
    expect(rows("SELECT COUNT(*) AS n FROM score_jobs")).toEqual([{ n: 1 }]);
    expect(rows("SELECT action FROM audit_log WHERE action = 'sources.change'")).toEqual([{ action: "sources.change" }]);
  });

  it("queues a job at once when the spacing allows it", async () => {
    await signInAt("u", "done", '["trader"]');
    exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('u', 'scoring', 1, 'v1')");
    exec(
      "INSERT INTO score_jobs (user_id, reason, status, queued_at, started_at) " +
        "VALUES ('u', 'connect', 'done', datetime('now', '-2 hours'), datetime('now', '-2 hours'))",
    );
    await expect(run(saveWalletsAction({}, form({ wallets: EVM })))).resolves.toBe("/profile");
    expect(rows("SELECT status FROM score_jobs ORDER BY id")).toEqual([{ status: "done" }, { status: "queued" }]);
  });
});
