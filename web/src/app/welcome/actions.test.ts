import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth/session";
import { claimCode } from "@/lib/verify/claim";
import { exec, fakeCookieJar, harness, RedirectCalled, resetHarness, rows, TEST_SECRET } from "@/test/harness";
import { loadAnswers } from "@/lib/onboarding/store";
import { savePlaceAction, saveRolesAction, saveTargetAction } from "./actions/answers";
import { saveDeliveryAction } from "./actions/delivery";
import { finishAction } from "./actions/finish";
import { continueSourcesAction, saveSourcesAction } from "./actions/sources";
import { checkCodeAction } from "./actions/verify";
import { saveWalletsAction, skipWalletsAction } from "./actions/wallets";
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

/**
 * Людина на кроці `step` з ролями `roles` і власною сесією (кука в новій банці). Кроки
 * «Stand out» і «done» бувають лише після згоди на бал (кінець анкети), тож тоді й згода.
 */
async function signInAt(id: string, step: string | null, roles = "[]") {
  exec("INSERT INTO users (id, email, onboarding_step, roles) VALUES (?, ?, ?, ?)", id, `${id}@example.com`, step, roles);
  if (step && ["x", "wallets", "sources", "done"].includes(step)) {
    exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES (?, 'scoring', 1, 'v1')", id);
  }
  harness.jar = fakeCookieJar();
  await createSession(id, null);
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
    await signInAt("u", "wallets", '["trader"]');
    await expect(run(saveWalletsAction({}, form({ wallets: EVM })))).resolves.toBe("/welcome?step=sources");
    expect(rows("SELECT kind, value FROM identities")).toEqual([{ kind: "evm", value: EVM }]);
    expect(rows("SELECT onboarding_step FROM users")).toEqual([{ onboarding_step: "sources" }]);
    // Згоду вже дано в кінці анкети, тож нові гаманці одразу йдуть у перерахунок.
    expect(rows("SELECT reason, status FROM score_jobs")).toEqual([{ reason: "connect", status: "queued" }]);
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
    exec(
      "INSERT INTO score_jobs (user_id, reason, status, queued_at, started_at) " +
        "VALUES ('u', 'connect', 'done', datetime('now', '-2 hours'), datetime('now', '-2 hours'))",
    );
    await expect(run(saveWalletsAction({}, form({ wallets: EVM })))).resolves.toBe("/profile");
    expect(rows("SELECT status FROM score_jobs ORDER BY id")).toEqual([{ status: "done" }, { status: "queued" }]);
  });
});

describe("brief first, then jobs, then the optional stand out steps", () => {
  it("saves how and when to send the jobs, then asks for consent", async () => {
    await signInAt("u", "delivery", '["engineer"]');
    await expect(run(saveDeliveryAction({}, form({ channel: "email", hour: "9", timezone: "Europe/Paris" })))).resolves.toBe(
      "/welcome?step=consent",
    );
    expect(rows("SELECT channel, digest_hour, timezone, digest_paused, onboarding_step FROM users")).toEqual([
      { channel: "email", digest_hour: 9, timezone: "Europe/Paris", digest_paused: 0, onboarding_step: "consent" },
    ]);
  });

  it("takes Telegram only when it is linked, and saves nothing on an error", async () => {
    await signInAt("u", "delivery", '["engineer"]');
    const state = await run(saveDeliveryAction({}, form({ channel: "telegram", hour: "9", timezone: "Europe/Paris" })));
    expect(state).toMatchObject({ errors: { channel: "Connect Telegram first." } });
    expect(rows("SELECT channel, digest_hour, timezone, onboarding_step FROM users")).toEqual([
      { channel: "email", digest_hour: 7, timezone: null, onboarding_step: "delivery" },
    ]);
  });

  it("ends the brief with consent and a score job, and shows the jobs at once", async () => {
    await signInAt("u", "consent", '["engineer"]');
    await expect(run(finishAction({}, form({ agree: "yes" })))).resolves.toBe("/jobs");
    expect(rows("SELECT kind, granted FROM consents")).toEqual([{ kind: "scoring", granted: 1 }]);
    expect(rows("SELECT reason, status FROM score_jobs")).toEqual([{ reason: "connect", status: "queued" }]);
    // Досягнуто перший крок «Stand out»: добірці вистачає ролей і першого балу.
    expect(rows("SELECT onboarding_step FROM users")).toEqual([{ onboarding_step: "x" }]);
  });

  it("lets a person skip X, wallets and sources without touching what they already added", async () => {
    await signInAt("u", "x", '["engineer"]');
    exec("INSERT INTO identities (user_id, kind, value) VALUES ('u', 'evm', ?)", EVM);
    await expect(run(continueXAction())).resolves.toBe("/welcome?step=wallets");
    await expect(run(skipWalletsAction())).resolves.toBe("/welcome?step=sources");
    await expect(run(continueSourcesAction())).resolves.toBe("/profile");
    expect(rows("SELECT kind, value FROM identities")).toEqual([{ kind: "evm", value: EVM }]);
    expect(rows("SELECT onboarding_step FROM users")).toEqual([{ onboarding_step: "done" }]);
  });

  it("after the brief, editing an answer goes back to the jobs; words still lead to roles", async () => {
    await signInAt("u", "wallets", '["engineer"]');
    await expect(run(savePlaceAction({}, form({ where: "remote", city: "", salary: "", currency: "USD" })))).resolves.toBe(
      "/jobs",
    );
    await expect(run(saveTargetAction({}, form({ target: "Rust engineer" })))).resolves.toBe("/welcome?step=roles");
    expect(rows("SELECT onboarding_step FROM users")).toEqual([{ onboarding_step: "wallets" }]);
  });

  it("someone who stopped at X under the old order (no consent yet) finishes the brief first", async () => {
    exec("INSERT INTO users (id, email, onboarding_step, roles) VALUES ('old', 'old@example.com', 'x', '[\"bd\"]')");
    harness.jar = fakeCookieJar();
    await createSession("old", null);
    expect((await loadAnswers(harness.env.DB, "old")).step).toBe("delivery");
    await expect(run(continueXAction())).resolves.toBe("/welcome");
    expect(rows("SELECT onboarding_step FROM users")).toEqual([{ onboarding_step: "x" }]);
  });
});
