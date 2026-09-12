import { beforeEach, describe, expect, it, vi } from "vitest";
import { exec, harness, resetHarness, rows } from "@/test/harness";
import {
  CODE_EMAIL_LIMITS,
  CODE_IP_LIMITS,
  VERIFY_EMAIL_LIMITS,
  checkRate,
  clearRate,
  clientIp,
  pruneRateStatement,
  recordAttempt,
  type Limits,
} from "./ratelimit";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);

const SQL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const LIMITS: Limits = { windowMinutes: 60, maxAttempts: 3, blockMinutes: 30 };

async function hit(key: string, times: number, limits = LIMITS) {
  for (let i = 0; i < times; i++) await recordAttempt(key, limits);
}

beforeEach(() => resetHarness());

describe("checkRate / recordAttempt", () => {
  it("allows a key it has never seen", async () => {
    await expect(checkRate("k")).resolves.toEqual({ allowed: true, retryAfterMinutes: 0 });
  });

  it("lets maxAttempts through and blocks the next one", async () => {
    await hit("k", 2);
    expect((await checkRate("k")).allowed).toBe(true);
    await hit("k", 1);
    const verdict = await checkRate("k");
    expect(verdict.allowed).toBe(false);
    expect(verdict.retryAfterMinutes).toBe(30);
  });

  it("keeps keys apart", async () => {
    await hit("a", 3);
    expect((await checkRate("a")).allowed).toBe(false);
    expect((await checkRate("b")).allowed).toBe(true);
  });

  it("is blocked when any of several keys is blocked", async () => {
    await hit("a", 3);
    expect((await checkRate("b", "a")).allowed).toBe(false);
    expect((await checkRate("b", "c")).allowed).toBe(true);
  });

  it("writes times in the SQLite format, never ISO", async () => {
    await hit("k", 3);
    const [row] = rows<{ window_start: string; blocked_until: string }>(
      "SELECT window_start, blocked_until FROM auth_attempts WHERE key = 'k'",
    );
    expect(row.window_start).toMatch(SQL_TIME);
    expect(row.blocked_until).toMatch(SQL_TIME);
  });

  it("lets the key go once the block has passed", async () => {
    await hit("k", 3);
    exec("UPDATE auth_attempts SET blocked_until = datetime('now', '-1 second') WHERE key = 'k'");
    expect((await checkRate("k")).allowed).toBe(true);
  });

  it("starts a new window when the old one is over", async () => {
    await hit("k", 2);
    exec("UPDATE auth_attempts SET window_start = datetime('now', '-61 minutes') WHERE key = 'k'");
    await hit("k", 1);
    const [row] = rows<{ attempts: number; blocked_until: string | null }>(
      "SELECT attempts, blocked_until FROM auth_attempts WHERE key = 'k'",
    );
    expect(row).toEqual({ attempts: 1, blocked_until: null });
  });

  it("clearRate forgets the key", async () => {
    await hit("k", 3);
    await clearRate("k");
    expect((await checkRate("k")).allowed).toBe(true);
  });

  it("prunes counters older than a day unless still blocked", async () => {
    await hit("old", 1);
    await hit("blocked", 3);
    await hit("fresh", 1);
    exec("UPDATE auth_attempts SET window_start = datetime('now', '-2 days') WHERE key IN ('old', 'blocked')");
    exec("UPDATE auth_attempts SET blocked_until = datetime('now', '+5 minutes') WHERE key = 'blocked'");
    await pruneRateStatement(harness.env.DB).run();
    expect(rows<{ key: string }>("SELECT key FROM auth_attempts ORDER BY key").map((r) => r.key)).toEqual([
      "blocked",
      "fresh",
    ]);
  });
});

describe("sign-in limits", () => {
  it("five codes per email per hour", async () => {
    expect(CODE_EMAIL_LIMITS).toMatchObject({ windowMinutes: 60, maxAttempts: 5 });
    await hit("code:email:a@b.co", 4, CODE_EMAIL_LIMITS);
    expect((await checkRate("code:email:a@b.co")).allowed).toBe(true);
    await hit("code:email:a@b.co", 1, CODE_EMAIL_LIMITS);
    expect((await checkRate("code:email:a@b.co")).allowed).toBe(false);
  });

  it("twenty codes per IP per hour", async () => {
    expect(CODE_IP_LIMITS).toMatchObject({ windowMinutes: 60, maxAttempts: 20 });
    await hit("code:ip:1.2.3.4", 19, CODE_IP_LIMITS);
    expect((await checkRate("code:ip:1.2.3.4")).allowed).toBe(true);
    await hit("code:ip:1.2.3.4", 1, CODE_IP_LIMITS);
    expect((await checkRate("code:ip:1.2.3.4")).allowed).toBe(false);
  });

  it("ten failed checks per email per 15 minutes", async () => {
    expect(VERIFY_EMAIL_LIMITS).toMatchObject({ windowMinutes: 15, maxAttempts: 10 });
    await hit("verify:email:a@b.co", 10, VERIFY_EMAIL_LIMITS);
    const verdict = await checkRate("verify:email:a@b.co");
    expect(verdict).toEqual({ allowed: false, retryAfterMinutes: 15 });
  });
});

describe("clientIp", () => {
  it("reads cf-connecting-ip", () => {
    expect(clientIp(new Headers({ "cf-connecting-ip": " 203.0.113.9 " }))).toBe("203.0.113.9");
  });

  it("falls back to one shared bucket outside Cloudflare", () => {
    expect(clientIp(new Headers())).toBe("unknown");
  });
});
