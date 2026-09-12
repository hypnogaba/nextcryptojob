import { beforeEach, describe, expect, it } from "vitest";
import { grantConsent } from "@/lib/consent";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import { ENQUEUE_SPACING_SECONDS, enqueueScoreJob } from "./queue";
import { isActive, profileStatus } from "./status";

let t: TestDb;
const jobs = (userId = "a") =>
  t.raw.prepare("SELECT reason, status FROM score_jobs WHERE user_id = ? ORDER BY id").all(userId).map((r) => ({ ...r }));
const age = (seconds: number) =>
  t.raw.exec(`UPDATE score_jobs SET queued_at = datetime('now', '-${seconds} seconds')`);

beforeEach(async () => {
  t = migratedD1();
  t.raw.exec("INSERT INTO users (id, email) VALUES ('a', 'a@example.com'), ('b', 'b@example.com')");
  await grantConsent(t.d1, "a", "scoring", "v1");
  await grantConsent(t.d1, "b", "scoring", "v1");
});

describe("enqueueScoreJob", () => {
  it("queues a job", async () => {
    await expect(enqueueScoreJob(t.d1, "a", "connect")).resolves.toMatchObject({ ok: true });
    expect(jobs()).toEqual([{ reason: "connect", status: "queued" }]);
  });

  it("does not add a second job while one is queued, however old", async () => {
    await enqueueScoreJob(t.d1, "a", "connect");
    age(3600);
    await expect(enqueueScoreJob(t.d1, "a", "manual")).resolves.toEqual({ ok: false, reason: "already_queued" });
    expect(jobs()).toHaveLength(1);
  });

  it("keeps 60 seconds between jobs of one person", async () => {
    await enqueueScoreJob(t.d1, "a", "connect");
    t.raw.exec("UPDATE score_jobs SET status = 'done'");
    const soon = await enqueueScoreJob(t.d1, "a", "manual");
    expect(soon).toMatchObject({ ok: false, reason: "too_soon" });
    expect(soon.ok === false && soon.reason === "too_soon" && soon.retryAfterSeconds).toBeGreaterThan(0);
    expect(soon.ok === false && soon.reason === "too_soon" && soon.retryAfterSeconds).toBeLessThanOrEqual(
      ENQUEUE_SPACING_SECONDS,
    );
    age(ENQUEUE_SPACING_SECONDS + 1);
    await expect(enqueueScoreJob(t.d1, "a", "manual")).resolves.toMatchObject({ ok: true });
    expect(jobs()).toHaveLength(2);
  });

  it("lets a failed job be tried again after the spacing", async () => {
    await enqueueScoreJob(t.d1, "a", "connect");
    t.raw.exec("UPDATE score_jobs SET status = 'failed', error = 'x'");
    age(ENQUEUE_SPACING_SECONDS + 5);
    await expect(enqueueScoreJob(t.d1, "a", "manual")).resolves.toMatchObject({ ok: true });
  });

  it("counts each person separately", async () => {
    await enqueueScoreJob(t.d1, "b", "connect");
    await expect(enqueueScoreJob(t.d1, "a", "connect")).resolves.toMatchObject({ ok: true });
  });

  it("never queues without the scoring consent", async () => {
    t.raw.exec("INSERT INTO users (id, email) VALUES ('c', 'c@example.com')");
    await expect(enqueueScoreJob(t.d1, "c", "connect")).resolves.toEqual({ ok: false, reason: "no_consent" });
    expect(jobs("c")).toEqual([]);
  });
});

describe("profileStatus", () => {
  it("is empty before anything happens", async () => {
    await expect(profileStatus(t.d1, "a")).resolves.toEqual({ job: null, scored: false });
  });

  it("reports the latest job of the person only", async () => {
    await enqueueScoreJob(t.d1, "a", "connect");
    t.raw.exec("UPDATE score_jobs SET status = 'failed' WHERE user_id = 'a'");
    await enqueueScoreJob(t.d1, "b", "connect");
    t.raw.exec(
      "INSERT INTO scores (user_id, role, score, breakdown_json, formula_version) VALUES ('b', 'bd', 50, '{}', 'v5')",
    );
    const a = await profileStatus(t.d1, "a");
    expect(a).toMatchObject({ job: { status: "failed" }, scored: false });
    expect(isActive(a)).toBe(false);
    const b = await profileStatus(t.d1, "b");
    expect(b).toMatchObject({ job: { status: "queued" }, scored: true });
    expect(isActive(b)).toBe(true);
  });
});
