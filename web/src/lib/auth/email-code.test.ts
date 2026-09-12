import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sqlTime } from "@/lib/time";
import { TEST_SECRET, exec, harness, resetHarness, rows } from "@/test/harness";
import {
  CODE_TTL_MINUTES,
  normaliseEmail,
  randomCode,
  requestCode,
  verifyCode,
} from "./email-code";
import { hmacSha256Hex } from "./hash";
import { SESSION_COOKIE } from "./session";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => (await import("@/test/harness")).navigationModule);

const IP = "203.0.113.7";
const SQL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

type Sent = { to: string; subject: string; text: string; html: string; from: unknown };
let outbox: Sent[] = [];

function fakeEmailBinding(): SendEmail {
  return {
    send: async (message: unknown) => {
      outbox.push(message as Sent);
      return { messageId: `m${outbox.length}` };
    },
  } as SendEmail;
}

/** Код з останнього листа, як його прочитала б людина. */
function lastCode(): string {
  const mail = outbox.at(-1);
  if (!mail) throw new Error("no email sent");
  return mail.subject.match(/(\d{6})$/)![1];
}

/** Будь-який код, крім правильного. */
function wrong(code: string): string {
  return String((Number(code) + 1) % 1_000_000).padStart(6, "0");
}

beforeEach(() => {
  outbox = [];
  resetHarness({ EMAIL: fakeEmailBinding() });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("randomCode", () => {
  it("is always six digits, leading zeros included", () => {
    for (let i = 0; i < 2000; i++) expect(randomCode()).toMatch(/^\d{6}$/);
  });

  it("spreads evenly over the first digit", () => {
    const n = 50_000;
    const counts = Array<number>(10).fill(0);
    for (let i = 0; i < n; i++) counts[Number(randomCode()[0])]++;
    // Кожна цифра очікувано 5000 разів; 6 сигм (~400) дає хибну тривогу рідше за раз на мільйон.
    for (const c of counts) expect(Math.abs(c - n / 10)).toBeLessThan(400);
  });

  it("rejects random values that would bias the result instead of folding them", () => {
    const values = [4_294_967_295, 4_294_000_000, 123_456_789];
    const fake = (arr: Uint32Array) => {
      arr[0] = values.shift()!;
      return arr;
    };
    vi.spyOn(crypto, "getRandomValues").mockImplementation(fake as typeof crypto.getRandomValues);
    // Перші два значення за межею 4 294 000 000 відкинуто, третє дає 456789.
    expect(randomCode()).toBe("456789");
    expect(values).toHaveLength(0);
  });
});

describe("normaliseEmail", () => {
  it("trims and lowercases", () => {
    expect(normaliseEmail("  Ada.Lovelace@Example.COM ")).toBe("ada.lovelace@example.com");
  });

  it.each(["", "ada", "ada@", "@example.com", "ada@example", "ada @example.com", "ada@exa mple.com", "a@b..co"])(
    "rejects %j",
    (raw) => {
      expect(normaliseEmail(raw)).toBeNull();
    },
  );

  it("rejects non-strings and overlong input", () => {
    expect(normaliseEmail(null)).toBeNull();
    expect(normaliseEmail(`${"a".repeat(250)}@example.com`)).toBeNull();
  });
});

describe("requestCode", () => {
  it("emails the code with the agreed wording", async () => {
    await expect(requestCode("Ada@Example.com", IP)).resolves.toEqual({ ok: true, email: "ada@example.com" });
    expect(outbox).toHaveLength(1);
    const mail = outbox[0];
    const code = lastCode();
    expect(mail.to).toBe("ada@example.com");
    expect(mail.subject).toBe(`Your NextCryptoJob code: ${code}`);
    expect(mail.text).toContain(code);
    expect(mail.text).toContain("It expires in 10 minutes.");
    expect(mail.text).toContain("If you did not ask for it, ignore this email.");
    expect(mail.html).toContain(code);
    expect(mail.from).toEqual({ email: "login@nextcryptojob.xyz", name: "NextCryptoJob" });
  });

  it("stores the HMAC of email:code, never the code itself", async () => {
    await requestCode("ada@example.com", IP);
    const code = lastCode();
    const stored = rows<Record<string, unknown>>("SELECT * FROM login_codes");
    expect(stored).toHaveLength(1);
    expect(stored[0].code_hash).toBe(await hmacSha256Hex(TEST_SECRET, `ada@example.com:${code}`));
    expect(JSON.stringify(stored)).not.toContain(code);
  });

  it("expires in 10 minutes, written as SQLite time", async () => {
    await requestCode("ada@example.com", IP);
    const [row] = rows<{ expires_at: string; minutes: number }>(
      "SELECT expires_at, (julianday(expires_at) - julianday('now')) * 1440 AS minutes FROM login_codes",
    );
    expect(row.expires_at).toMatch(SQL_TIME);
    expect(row.minutes).toBeGreaterThan(CODE_TTL_MINUTES - 0.1);
    expect(row.minutes).toBeLessThanOrEqual(CODE_TTL_MINUTES);
  });

  it("a new request replaces the unused old code", async () => {
    await requestCode("ada@example.com", IP);
    const oldCode = lastCode();
    await requestCode("ada@example.com", IP);
    const newCode = lastCode();
    expect(rows("SELECT id FROM login_codes WHERE used_at IS NULL")).toHaveLength(1);
    if (oldCode !== newCode) {
      await expect(verifyCode("ada@example.com", oldCode)).resolves.toMatchObject({ ok: false });
    }
    await expect(verifyCode("ada@example.com", newCode)).resolves.toMatchObject({ ok: true });
  });

  it("answers the same way for a known and an unknown address", async () => {
    exec("INSERT INTO users (id, email) VALUES ('u1', 'known@example.com')");
    const known = await requestCode("known@example.com", IP);
    const unknown = await requestCode("new@example.com", IP);
    expect(Object.keys(known)).toEqual(Object.keys(unknown));
    expect(known.ok).toBe(unknown.ok);
  });

  it("refuses a malformed address without touching the database", async () => {
    await expect(requestCode("not-an-email", IP)).resolves.toEqual({ ok: false, reason: "invalid_email" });
    expect(rows("SELECT id FROM login_codes")).toHaveLength(0);
    expect(outbox).toHaveLength(0);
  });

  it("allows five codes per address per hour, then rate-limits", async () => {
    for (let i = 0; i < 5; i++) {
      await expect(requestCode("ada@example.com", IP)).resolves.toMatchObject({ ok: true });
    }
    const sixth = await requestCode("ADA@example.com", "198.51.100.1");
    expect(sixth).toMatchObject({ ok: false, reason: "rate_limited" });
    expect(sixth.ok === false && sixth.retryAfterMinutes).toBeGreaterThan(0);
    expect(outbox).toHaveLength(5);
  });

  it("allows twenty codes per IP per hour, then rate-limits", async () => {
    for (let i = 0; i < 20; i++) {
      await expect(requestCode(`p${i}@example.com`, IP)).resolves.toMatchObject({ ok: true });
    }
    await expect(requestCode("p20@example.com", IP)).resolves.toMatchObject({ ok: false, reason: "rate_limited" });
    await expect(requestCode("p20@example.com", "198.51.100.1")).resolves.toMatchObject({ ok: true });
  });

  it("a burst of 30 parallel requests for one address sends at most five emails", async () => {
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, i) => requestCode("ada@example.com", `198.51.100.${i}`)),
    );
    // Не «до п'яти», а рівно п'ять: ліміт і не пропускає зайвих, і не глухне.
    expect(outbox).toHaveLength(5);
    expect(results.filter((r) => r.ok)).toHaveLength(5);
    expect(results.filter((r) => !r.ok && r.reason === "rate_limited")).toHaveLength(25);
  });

  it("a burst of 30 parallel requests from one IP sends at most twenty emails", async () => {
    await Promise.all(Array.from({ length: 30 }, (_, i) => requestCode(`p${i}@example.com`, IP)));
    expect(outbox).toHaveLength(20);
  });

  it("allows ten codes per address per day, even spread over hours", async () => {
    const sendFive = async () => {
      for (let i = 0; i < 5; i++) await requestCode("ada@example.com", IP);
      // Година минула: погодинний ліміт відпускає, добовий ні.
      exec(
        `UPDATE auth_attempts SET window_start = datetime('now', '-61 minutes'), blocked_until = NULL
          WHERE key IN ('code:email:ada@example.com', 'code:ip:${IP}')`,
      );
    };
    await sendFive();
    await sendFive();
    expect(outbox).toHaveLength(10);
    await expect(requestCode("ada@example.com", IP)).resolves.toMatchObject({ ok: false, reason: "rate_limited" });
    expect(outbox).toHaveLength(10);
  });

  it("reports a failed send instead of pretending", async () => {
    harness.env.EMAIL = { send: async () => Promise.reject(new Error("E_SENDER_NOT_VERIFIED")) } as unknown as SendEmail;
    await expect(requestCode("ada@example.com", IP)).resolves.toEqual({ ok: false, reason: "send_failed" });
  });

  it("a failed send keeps the previous code working", async () => {
    await requestCode("ada@example.com", IP);
    const previous = lastCode();
    harness.env.EMAIL = { send: async () => Promise.reject(new Error("E_RATE_LIMIT_EXCEEDED")) } as unknown as SendEmail;
    await expect(requestCode("ada@example.com", IP)).resolves.toEqual({ ok: false, reason: "send_failed" });
    expect(rows("SELECT id FROM login_codes WHERE used_at IS NULL")).toHaveLength(1);
    await expect(verifyCode("ada@example.com", previous)).resolves.toMatchObject({ ok: true });
  });

  it("refuses a SESSION_SECRET shorter than 32 characters", async () => {
    harness.env.SESSION_SECRET = "x".repeat(31);
    await expect(requestCode("ada@example.com", IP)).resolves.toEqual({ ok: false, reason: "email_unavailable" });
    await expect(verifyCode("ada@example.com", "123456")).resolves.toEqual({ ok: false, reason: "email_unavailable" });
    expect(outbox).toHaveLength(0);
    expect(rows("SELECT id FROM login_codes")).toHaveLength(0);
  });

  it("in production without the mail binding says email is unavailable", async () => {
    vi.stubEnv("NODE_ENV", "production");
    harness.env.EMAIL = undefined;
    await expect(requestCode("ada@example.com", IP)).resolves.toEqual({ ok: false, reason: "email_unavailable" });
    expect(rows("SELECT id FROM login_codes")).toHaveLength(0);
    expect(rows("SELECT key FROM auth_attempts")).toHaveLength(0);
  });

  it("without SESSION_SECRET says email is unavailable", async () => {
    harness.env.SESSION_SECRET = undefined;
    await expect(requestCode("ada@example.com", IP)).resolves.toEqual({ ok: false, reason: "email_unavailable" });
    expect(outbox).toHaveLength(0);
  });

  it("in development without the binding prints the email to the log", async () => {
    harness.env.EMAIL = undefined;
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await expect(requestCode("ada@example.com", IP)).resolves.toMatchObject({ ok: true });
    expect(info).toHaveBeenCalledTimes(1);
    expect(String(info.mock.calls[0][0])).toMatch(/Your NextCryptoJob code: \d{6}/);
  });
});

describe("verifyCode", () => {
  async function sendCode(email = "ada@example.com"): Promise<string> {
    const res = await requestCode(email, IP);
    expect(res.ok).toBe(true);
    return lastCode();
  }

  it("signs in with the right code: creates the person, session and audit entry", async () => {
    const code = await sendCode();
    const res = await verifyCode("ada@example.com", code);
    expect(res).toMatchObject({ ok: true, created: true });
    if (!res.ok) throw new Error("unreachable");

    const users = rows<{ id: string; email: string; channel: string }>("SELECT id, email, channel FROM users");
    expect(users).toEqual([{ id: res.userId, email: "ada@example.com", channel: "email" }]);
    expect(res.userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(harness.jar.store.has(SESSION_COOKIE)).toBe(true);
    expect(rows("SELECT id FROM sessions WHERE user_id = ?", res.userId)).toHaveLength(1);

    const log = rows<{ actor: string; action: string; target: string; meta_json: string }>(
      "SELECT actor, action, target, meta_json FROM audit_log",
    );
    expect(log).toEqual([
      { actor: res.userId, action: "auth.login_email", target: res.userId, meta_json: '{"created":true}' },
    ]);
    expect(log[0].meta_json).not.toContain("@");
  });

  it("accepts the code with spaces, as pasted", async () => {
    const code = await sendCode();
    await expect(verifyCode("ada@example.com", `${code.slice(0, 3)} ${code.slice(3)}`)).resolves.toMatchObject({
      ok: true,
    });
  });

  it("finds the same person again, whatever the case of the address", async () => {
    const first = await verifyCode("Ada@Example.com", await sendCode("Ada@Example.com"));
    const second = await verifyCode(" ADA@example.COM ", await sendCode("ada@example.com"));
    expect(first).toMatchObject({ ok: true, created: true });
    expect(second).toMatchObject({ ok: true, created: false });
    if (!first.ok || !second.ok) throw new Error("unreachable");
    expect(second.userId).toBe(first.userId);
    expect(rows("SELECT id FROM users")).toHaveLength(1);
  });

  it("signs in a person who already exists without creating another", async () => {
    exec("INSERT INTO users (id, email, channel) VALUES ('tg-user', 'ada@example.com', 'telegram')");
    const res = await verifyCode("ada@example.com", await sendCode());
    expect(res).toMatchObject({ ok: true, userId: "tg-user", created: false });
    expect(rows("SELECT channel FROM users")).toEqual([{ channel: "telegram" }]);
  });

  it("finds a person whose stored address has capitals instead of creating a twin", async () => {
    exec("INSERT INTO users (id, email) VALUES ('legacy', 'Ada@Example.com')");
    const res = await verifyCode("ada@example.com", await sendCode());
    expect(res).toMatchObject({ ok: true, userId: "legacy", created: false });
    expect(rows("SELECT id FROM users")).toHaveLength(1);
  });

  it("a failed audit write leaves nobody half signed in", async () => {
    const code = await sendCode();
    exec("DROP TABLE audit_log");
    await expect(verifyCode("ada@example.com", code)).rejects.toThrow();
    expect(harness.jar.store.has(SESSION_COOKIE)).toBe(false);
    expect(rows("SELECT id FROM sessions")).toHaveLength(0);
  });

  it("30 parallel wrong guesses count exactly five tries", async () => {
    const bad = wrong(await sendCode());
    const results = await Promise.all(Array.from({ length: 30 }, () => verifyCode("ada@example.com", bad)));
    expect(results.some((r) => r.ok)).toBe(false);
    expect(rows("SELECT attempts FROM login_codes")).toEqual([{ attempts: 5 }]);
    expect(results.filter((r) => !r.ok && r.reason === "wrong_code")).toHaveLength(4);
  });

  it("a code works once", async () => {
    const code = await sendCode();
    await expect(verifyCode("ada@example.com", code)).resolves.toMatchObject({ ok: true });
    await expect(verifyCode("ada@example.com", code)).resolves.toEqual({ ok: false, reason: "expired" });
  });

  it("a code is bound to its address", async () => {
    const code = await sendCode("ada@example.com");
    await sendCode("bob@example.com");
    const res = await verifyCode("bob@example.com", code);
    if (lastCode() !== code) expect(res).toMatchObject({ ok: false, reason: "wrong_code" });
  });

  it("refuses an expired code", async () => {
    const code = await sendCode();
    exec("UPDATE login_codes SET expires_at = ?", sqlTime(new Date(Date.now() - 1000)));
    await expect(verifyCode("ada@example.com", code)).resolves.toEqual({ ok: false, reason: "expired" });
    expect(rows("SELECT id FROM users")).toHaveLength(0);
  });

  it("accepts a code that expires a moment from now", async () => {
    const code = await sendCode();
    exec("UPDATE login_codes SET expires_at = ?", sqlTime(new Date(Date.now() + 5000)));
    await expect(verifyCode("ada@example.com", code)).resolves.toMatchObject({ ok: true });
  });

  it("counts wrong tries down and stops after five", async () => {
    const code = await sendCode();
    const bad = wrong(code);
    for (const left of [4, 3, 2, 1]) {
      await expect(verifyCode("ada@example.com", bad)).resolves.toEqual({
        ok: false,
        reason: "wrong_code",
        attemptsLeft: left,
      });
    }
    await expect(verifyCode("ada@example.com", bad)).resolves.toEqual({ ok: false, reason: "too_many_attempts" });
    // Навіть правильний код після п'яти спроб не відкриває.
    await expect(verifyCode("ada@example.com", code)).resolves.toEqual({ ok: false, reason: "too_many_attempts" });
    expect(rows("SELECT attempts FROM login_codes")).toEqual([{ attempts: 5 }]);
    expect(harness.jar.store.has(SESSION_COOKIE)).toBe(false);
  });

  it("rate-limits after ten wrong tries across codes in 15 minutes", async () => {
    for (let round = 0; round < 2; round++) {
      const bad = wrong(await sendCode());
      for (let i = 0; i < 5; i++) await verifyCode("ada@example.com", bad);
    }
    const code = await sendCode();
    await expect(verifyCode("ada@example.com", code)).resolves.toMatchObject({ ok: false, reason: "rate_limited" });
  });

  it("a successful sign-in clears the failed-try counter", async () => {
    const code = await sendCode();
    await verifyCode("ada@example.com", wrong(code));
    await verifyCode("ada@example.com", code);
    expect(rows("SELECT key FROM auth_attempts WHERE key LIKE 'verify:%'")).toHaveLength(0);
  });

  it("refuses when no code was asked for, and does not reveal anything else", async () => {
    exec("INSERT INTO users (id, email) VALUES ('u1', 'known@example.com')");
    const known = await verifyCode("known@example.com", "123456");
    const unknown = await verifyCode("new@example.com", "123456");
    expect(known).toEqual({ ok: false, reason: "expired" });
    expect(unknown).toEqual(known);
  });

  it("refuses a malformed code without spending a try", async () => {
    await sendCode();
    await expect(verifyCode("ada@example.com", "12345")).resolves.toEqual({ ok: false, reason: "invalid_code" });
    await expect(verifyCode("ada@example.com", "abcdef")).resolves.toEqual({ ok: false, reason: "invalid_code" });
    expect(rows("SELECT attempts FROM login_codes")).toEqual([{ attempts: 0 }]);
  });
});
