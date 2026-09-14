import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth/session";
import { claimCode } from "@/lib/verify/claim";
import { exec, fakeCookieJar, harness, RedirectCalled, resetHarness, rows, TEST_SECRET } from "@/test/harness";
import { loadAnswers } from "@/lib/onboarding/store";
import { savePlaceAction, saveRolesAction, saveTargetAction } from "./actions/answers";
import { saveDeliveryAction } from "./actions/delivery";
import { continueSourcesAction, saveSourcesAction } from "./actions/sources";
import { checkCodeAction } from "./actions/verify";
import { saveWalletsAction, skipWalletsAction } from "./actions/wallets";
import { saveXAction } from "./actions/x";

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
 * «Stand out» і «done» бувають лише після умов (кінець анкети), тож тоді й прийняті умови.
 */
async function signInAt(id: string, step: string | null, roles = "[]") {
  exec("INSERT INTO users (id, email, onboarding_step, roles) VALUES (?, ?, ?, ?)", id, `${id}@example.com`, step, roles);
  if (step && ["x", "wallets", "sources", "done"].includes(step)) {
    exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES (?, 'terms', 1, 'terms-0.2')", id);
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
    await expect(run(saveXAction({}, form({ handle: "ada" })))).resolves.toBe("/welcome");
    await expect(run(saveDeliveryAction({}, form({ channel: "email", hour: "9", timezone: "UTC" })))).resolves.toBe("/welcome");
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
    await signInAt("u", "delivery");
    await expect(run(saveDeliveryAction({}, form({ channel: "email", hour: "9", timezone: "UTC" })))).resolves.toBe(
      "/welcome?step=roles",
    );
    expect(rows("SELECT * FROM score_jobs")).toEqual([]);
    expect(rows("SELECT * FROM consents")).toEqual([]);
  });

  it("sends a visitor without a session to sign in", async () => {
    await expect(run(saveRolesAction({}, form({ role: "bd" })))).resolves.toBe("/login");
  });
});

describe("claiming an X handle someone else typed in first (the one place a code is still used)", () => {
  it("offers a claim code, then moves the handle on a found code", async () => {
    await signInAt("squatter", "x");
    await expect(run(saveXAction({}, form({ handle: "ada" })))).resolves.toBe("/welcome?step=wallets");
    await signInAt("owner", "x");
    await expect(run(saveXAction({}, form({ handle: "@Ada" })))).resolves.toBe("/welcome?step=x&claim=ada");

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
    await run(saveXAction({}, form({ handle: "ada" })));
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
  it("the brief ends on the delivery step: saving it accepts the terms, queues a score and goes straight to X", async () => {
    await signInAt("u", "delivery", '["engineer"]');
    await expect(run(saveDeliveryAction({}, form({ channel: "email", hour: "9", timezone: "Europe/Paris" })))).resolves.toBe(
      "/welcome?step=x",
    );
    expect(rows("SELECT channel, digest_hour, timezone, digest_paused, onboarding_step FROM users")).toEqual([
      { channel: "email", digest_hour: 9, timezone: "Europe/Paris", digest_paused: 0, onboarding_step: "x" },
    ]);
    expect(rows("SELECT reason, status FROM score_jobs")).toEqual([{ reason: "connect", status: "queued" }]);
  });

  it("takes Telegram only when it is linked, and saves nothing on an error", async () => {
    await signInAt("u", "delivery", '["engineer"]');
    const state = await run(saveDeliveryAction({}, form({ channel: "telegram", hour: "9", timezone: "Europe/Paris" })));
    expect(state).toMatchObject({ errors: { channel: "Connect Telegram first." } });
    expect(rows("SELECT channel, digest_hour, timezone, onboarding_step FROM users")).toEqual([
      { channel: "email", digest_hour: 7, timezone: null, onboarding_step: "delivery" },
    ]);
    expect(rows("SELECT * FROM consents")).toEqual([]);
  });

  it("someone saved on the old consent step resumes on delivery, where the last button now is", async () => {
    await signInAt("u", "consent", '["engineer"]');
    expect((await loadAnswers(harness.env.DB, "u")).step).toBe("delivery");
    await expect(run(saveDeliveryAction({}, form({ channel: "email", hour: "9", timezone: "UTC" })))).resolves.toBe(
      "/welcome?step=x",
    );
    expect(rows("SELECT onboarding_step FROM users")).toEqual([{ onboarding_step: "x" }]);
  });

  it("X is required; wallets and sources can be skipped; the last step leads to the score page", async () => {
    await signInAt("u", "x", '["engineer"]');
    exec("INSERT INTO identities (user_id, kind, value) VALUES ('u', 'evm', ?)", EVM);
    // Без X далі не пускає: крок гаманців відсилає назад, а порожній нік не зберігається.
    await expect(run(skipWalletsAction())).resolves.toBe("/welcome");
    await expect(run(saveXAction({}, form({ handle: "  " })))).resolves.toMatchObject({ errors: { handle: "Enter your X handle." } });
    await expect(run(saveXAction({}, form({ handle: "https://x.com/Ada_Dev" })))).resolves.toBe("/welcome?step=wallets");
    await expect(run(skipWalletsAction())).resolves.toBe("/welcome?step=sources");
    await expect(run(continueSourcesAction())).resolves.toBe("/welcome/score");
    expect(rows("SELECT kind, value FROM identities ORDER BY id")).toEqual([
      { kind: "evm", value: EVM },
      { kind: "x", value: "ada_dev" },
    ]);
    expect(rows("SELECT onboarding_step FROM users")).toEqual([{ onboarding_step: "done" }]);
  });

  it("trusts the handle: no code, nothing to verify, and it counts toward the score at once", async () => {
    await signInAt("u", "x", '["bd"]');
    await expect(run(saveXAction({}, form({ handle: "@Ada" })))).resolves.toBe("/welcome?step=wallets");
    expect(rows("SELECT value, verify_code, verified_at FROM identities WHERE kind = 'x'")).toEqual([
      { value: "ada", verify_code: null, verified_at: null },
    ]);
    // Згоду дано в кінці анкети: нік одразу йде в перерахунок.
    expect(rows("SELECT reason, status FROM score_jobs")).toEqual([{ reason: "connect", status: "queued" }]);
    // Той самий нік ще раз: нічого не міняє й не ставить друге завдання.
    await expect(run(saveXAction({}, form({ handle: "ada" })))).resolves.toBe("/welcome?step=wallets");
    expect(rows("SELECT COUNT(*) AS n FROM score_jobs")).toEqual([{ n: 1 }]);
  });

  it("saves GitHub without a verification code, and Sherlock is not a field any more", async () => {
    await signInAt("u", "sources", '["engineer"]');
    exec("INSERT INTO identities (user_id, kind, value) VALUES ('u', 'x', 'ada')");
    exec("INSERT INTO identities (user_id, kind, value) VALUES ('u', 'sherlock', 'old')");
    await expect(run(saveSourcesAction({}, form({ github: "github.com/Ada", youtube: "", site: "", sherlock: "new" })))).resolves.toBe(
      "/welcome/score",
    );
    expect(rows("SELECT kind, value, verify_code FROM identities ORDER BY id")).toEqual([
      { kind: "x", value: "ada", verify_code: null },
      { kind: "sherlock", value: "old", verify_code: null },
      { kind: "github", value: "ada", verify_code: null },
    ]);
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
    await expect(run(saveXAction({}, form({ handle: "ada" })))).resolves.toBe("/welcome");
    expect(rows("SELECT onboarding_step FROM users")).toEqual([{ onboarding_step: "x" }]);
  });
});

describe("roles: our guess from the brief, and a role in the person's own words", () => {
  it("saves the confirmed roles and the own-words role together", async () => {
    await signInAt("u", "roles");
    await expect(
      run(saveRolesAction({}, form({ role: ["bd", "marketing_content"], role_text: "  Tokenomics   designer " }))),
    ).resolves.toBe("/welcome?step=place");
    expect(rows("SELECT roles, role_text FROM users")).toEqual([{ roles: '["bd","marketing_content"]', role_text: "Tokenomics designer" }]);
    expect((await loadAnswers(harness.env.DB, "u")).roleText).toBe("Tokenomics designer");
  });

  it("with no role picked, reads one from the own-words role; with nothing to read, asks for the closest", async () => {
    await signInAt("u", "roles");
    await expect(run(saveRolesAction({}, form({ role_text: "Governance and partnerships lead" })))).resolves.toBe("/welcome?step=place");
    expect(rows("SELECT roles, role_text FROM users WHERE id = 'u'")).toEqual([{ roles: '["bd"]', role_text: "Governance and partnerships lead" }]);

    await signInAt("v", "roles");
    const state = await run(saveRolesAction({}, form({ role_text: "Chief vibes officer" })));
    expect(state).toMatchObject({ errors: { role: expect.stringMatching(/closest role/) }, values: { role_text: "Chief vibes officer" } });
    expect(rows("SELECT roles, role_text FROM users WHERE id = 'v'")).toEqual([{ roles: "[]", role_text: null }]);
  });

  it("clears the own-words role when the field is emptied", async () => {
    await signInAt("u", "roles");
    await run(saveRolesAction({}, form({ role: "bd", role_text: "Tokenomics" })));
    expect(rows("SELECT role_text FROM users")).toEqual([{ role_text: "Tokenomics" }]);
    await run(saveRolesAction({}, form({ role: "bd", role_text: "" })));
    expect(rows("SELECT role_text FROM users")).toEqual([{ role_text: null }]);
  });
});

describe("no consent boxes (owner 14.09, round 3): continuing accepts the terms", () => {
  const sharing = () => rows("SELECT visible_to_companies AS visible, contact_mode FROM users WHERE id = 'u'");
  const events = () => rows("SELECT kind, granted, text_version FROM consent_events ORDER BY id");
  const deliver = () => run(saveDeliveryAction({}, form({ channel: "email", hour: "9", timezone: "UTC" })));

  it("one consent event, the terms with their version; visible and Telegram directly are on by default", async () => {
    await signInAt("u", "delivery", '["engineer"]');
    await expect(deliver()).resolves.toBe("/welcome?step=x");
    expect(events()).toEqual([{ kind: "terms", granted: 1, text_version: "terms-0.2" }]);
    expect(rows("SELECT kind, granted, text_version FROM consents ORDER BY kind")).toEqual([
      { kind: "contact", granted: 1, text_version: "terms-0.2" },
      { kind: "terms", granted: 1, text_version: "terms-0.2" },
      { kind: "visibility", granted: 1, text_version: "terms-0.2" },
    ]);
    expect(sharing()).toEqual([{ visible: 1, contact_mode: "direct" }]);
    expect(rows("SELECT action, meta_json FROM audit_log WHERE action LIKE 'terms.%' OR action LIKE 'consent.%'")).toEqual([
      { action: "terms.accept", meta_json: JSON.stringify({ version: "terms-0.2" }) },
    ]);
  });

  it("a choice made in Settings before the end of the brief is kept (hidden stays hidden)", async () => {
    await signInAt("u", "delivery", '["engineer"]');
    exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('u', 'visibility', 0, 'visibility.v1')");
    await deliver();
    expect(sharing()).toEqual([{ visible: 0, contact_mode: "direct" }]);
    expect(rows("SELECT granted, text_version FROM consents WHERE kind = 'visibility'")).toEqual([
      { granted: 0, text_version: "visibility.v1" },
    ]);
  });

  it("people who already finished the brief keep their settings when they edit the delivery step", async () => {
    await signInAt("u", "done", '["engineer"]');
    exec("DELETE FROM consents WHERE user_id = 'u'");
    exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('u', 'scoring', 1, 'v1')");
    await expect(deliver()).resolves.toBe("/jobs");
    expect(sharing()).toEqual([{ visible: 0, contact_mode: "approval" }]);
    expect(events()).toEqual([]);
  });

  it("the old scoring consent still counts as the basis for a score", async () => {
    await signInAt("u", "x", '["bd"]');
    exec("UPDATE consents SET kind = 'scoring', text_version = 'v1' WHERE user_id = 'u'");
    await expect(run(saveXAction({}, form({ handle: "ada" })))).resolves.toBe("/welcome?step=wallets");
    expect(rows("SELECT reason, status FROM score_jobs")).toEqual([{ reason: "connect", status: "queued" }]);
  });
});
