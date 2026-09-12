import { beforeEach, describe, expect, it } from "vitest";
import { grantConsent } from "@/lib/consent";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import { ENQUEUE_SPACING_SECONDS, enqueueScoreJob } from "./queue";
import { markSourcesChanged } from "./changes";
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

describe("sources changed since the last score", () => {
  const setJob = (status: string, startedAgo: number | null, queuedAgo: number) =>
    t.raw.exec(
      `UPDATE score_jobs SET status = '${status}', queued_at = datetime('now', '-${queuedAgo} seconds'), ` +
        `started_at = ${startedAgo === null ? "NULL" : `datetime('now', '-${startedAgo} seconds')`}`,
    );
  const changeAgo = (seconds: number) =>
    t.raw.exec(`UPDATE audit_log SET at = datetime('now', '-${seconds} seconds') WHERE action = 'sources.change'`);

  it("is true when a change came after the last job started", async () => {
    await enqueueScoreJob(t.d1, "a", "connect");
    setJob("done", 100, 120);
    await markSourcesChanged(t.d1, "a", "wallets");
    changeAgo(50);
    await expect(profileStatus(t.d1, "a")).resolves.toMatchObject({ sourcesChanged: true });
  });

  it("is false when the last job started after the change", async () => {
    await markSourcesChanged(t.d1, "a", "x");
    changeAgo(200);
    await enqueueScoreJob(t.d1, "a", "connect");
    setJob("done", 100, 120);
    await expect(profileStatus(t.d1, "a")).resolves.toMatchObject({ sourcesChanged: false });
  });

  it("is false while a job is still queued: it will read the fresh sources", async () => {
    await enqueueScoreJob(t.d1, "a", "connect");
    await markSourcesChanged(t.d1, "a", "roles");
    await expect(profileStatus(t.d1, "a")).resolves.toMatchObject({ sourcesChanged: false });
  });

  it("is true for a change during a running job, and for a change with no job at all", async () => {
    await enqueueScoreJob(t.d1, "a", "connect");
    setJob("running", 30, 40);
    await markSourcesChanged(t.d1, "a", "github");
    changeAgo(10);
    await expect(profileStatus(t.d1, "a")).resolves.toMatchObject({ sourcesChanged: true });
    await markSourcesChanged(t.d1, "b", "x");
    await expect(profileStatus(t.d1, "b")).resolves.toMatchObject({ sourcesChanged: true });
  });

  it("records the change without personal data", async () => {
    await markSourcesChanged(t.d1, "a", "wallets");
    expect(t.raw.prepare("SELECT actor, action, target, meta_json FROM audit_log").all().map((r) => ({ ...r }))).toEqual([
      { actor: "a", action: "sources.change", target: "a", meta_json: '{"what":"wallets"}' },
    ]);
  });
});

describe("profileStatus", () => {
  it("is empty before anything happens", async () => {
    await expect(profileStatus(t.d1, "a")).resolves.toEqual({ job: null, scored: false, sourcesChanged: false });
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
