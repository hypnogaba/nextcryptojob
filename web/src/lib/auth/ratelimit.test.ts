import { beforeEach, describe, expect, it, vi } from "vitest";
import { exec, harness, resetHarness, rows } from "@/test/harness";
import {
  CODE_EMAIL_DAY_LIMITS,
  CODE_EMAIL_LIMITS,
  CODE_IP_LIMITS,
  VERIFY_EMAIL_LIMITS,
  clearRate,
  clientIp,
  consume,
  pruneRateStatement,
  type Limits,
} from "./ratelimit";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);

const SQL_TIME = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const LIMITS: Limits = { windowMinutes: 60, maxAttempts: 3, blockMinutes: 30 };

/** Скільки з n послідовних спроб пропущено. */
async function allowedOf(key: string, n: number, limits = LIMITS): Promise<number> {
  let allowed = 0;
  for (let i = 0; i < n; i++) if ((await consume(key, limits)).allowed) allowed++;
  return allowed;
}

beforeEach(() => resetHarness());

describe("consume", () => {
  it("lets maxAttempts through in a window and refuses the next", async () => {
    expect(await allowedOf("k", 3)).toBe(3);
    await expect(consume("k", LIMITS)).resolves.toEqual({ allowed: false, retryAfterMinutes: 30 });
  });

  it("keeps keys apart", async () => {
    await allowedOf("a", 4);
    expect((await consume("a", LIMITS)).allowed).toBe(false);
    expect((await consume("b", LIMITS)).allowed).toBe(true);
  });

  it("counts a burst of parallel attempts exactly: never more than maxAttempts pass", async () => {
    const verdicts = await Promise.all(Array.from({ length: 30 }, () => consume("k", LIMITS)));
    expect(verdicts.filter((v) => v.allowed)).toHaveLength(3);
  });

  it("writes times in the SQLite format, never ISO", async () => {
    await allowedOf("k", 4);
    const [row] = rows<{ window_start: string; blocked_until: string }>(
      "SELECT window_start, blocked_until FROM auth_attempts WHERE key = 'k'",
    );
    expect(row.window_start).toMatch(SQL_TIME);
    expect(row.blocked_until).toMatch(SQL_TIME);
  });

  it("stays refused while blocked, even when the window is over", async () => {
    await allowedOf("k", 4);
    exec("UPDATE auth_attempts SET window_start = datetime('now', '-2 hours') WHERE key = 'k'");
    expect((await consume("k", LIMITS)).allowed).toBe(false);
  });

  it("opens again once both the block and the window are over", async () => {
    await allowedOf("k", 4);
    exec(
      "UPDATE auth_attempts SET window_start = datetime('now', '-2 hours'), blocked_until = datetime('now', '-1 second') WHERE key = 'k'",
    );
    expect(await allowedOf("k", 4)).toBe(3);
  });

  it("starts a new window when the old one is over", async () => {
    await allowedOf("k", 2);
    exec("UPDATE auth_attempts SET window_start = datetime('now', '-61 minutes') WHERE key = 'k'");
    expect(await allowedOf("k", 3)).toBe(3);
  });

  it("clearRate forgets the key", async () => {
    await allowedOf("k", 4);
    await clearRate("k");
    expect((await consume("k", LIMITS)).allowed).toBe(true);
  });

  it("prunes counters older than a day unless still blocked", async () => {
    await allowedOf("old", 1);
    await allowedOf("blocked", 4);
    await allowedOf("fresh", 1);
    exec("UPDATE auth_attempts SET window_start = datetime('now', '-2 days') WHERE key IN ('old', 'blocked')");
    await pruneRateStatement(harness.env.DB).run();
    expect(rows<{ key: string }>("SELECT key FROM auth_attempts ORDER BY key").map((r) => r.key)).toEqual([
      "blocked",
      "fresh",
    ]);
  });
});

describe("sign-in limits", () => {
  it("five codes per email per hour", async () => {
    expect(CODE_EMAIL_LIMITS.windowMinutes).toBe(60);
    expect(await allowedOf("code:email:a@b.co", 8, CODE_EMAIL_LIMITS)).toBe(5);
  });

  it("ten codes per email per day", async () => {
    expect(CODE_EMAIL_DAY_LIMITS.windowMinutes).toBe(24 * 60);
    expect(await allowedOf("code:email:day:a@b.co", 15, CODE_EMAIL_DAY_LIMITS)).toBe(10);
  });

  it("twenty codes per IP per hour", async () => {
    expect(CODE_IP_LIMITS.windowMinutes).toBe(60);
    expect(await allowedOf("code:ip:1.2.3.4", 25, CODE_IP_LIMITS)).toBe(20);
  });

  it("ten code checks per email per 15 minutes", async () => {
    expect(VERIFY_EMAIL_LIMITS.windowMinutes).toBe(15);
    expect(await allowedOf("verify:email:a@b.co", 12, VERIFY_EMAIL_LIMITS)).toBe(10);
    await expect(consume("verify:email:a@b.co", VERIFY_EMAIL_LIMITS)).resolves.toEqual({
      allowed: false,
      retryAfterMinutes: 15,
    });
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
