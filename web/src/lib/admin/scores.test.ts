import { describe, expect, it } from "vitest";
import { addUser, crmDb, run } from "@/test/crm-fixtures";
import { listCandidates, loadScoreDistribution, loadUserScoreDetail, searchScoreUsers } from "./scores";

/**
 * /admin/scores і /admin/scores/[userId] (C): гістограма і середнє за роллю, «підозрілі»
 * (низьке покриття при рівні 8+, або 0/null при наявних ідентичностях), пошук за поштою
 * і X-ніком, і що розбір людини використовує той самий explainRole, що її власна сторінка.
 */

function seed() {
  const { raw, d1 } = crmDb();
  const u1 = addUser(raw, { id: "u1", email: "ada@example.com" });
  const u2 = addUser(raw, { id: "u2", email: "bob@example.com" });
  run(raw, `INSERT INTO identities (user_id, kind, value) VALUES ('u1', 'x', 'ada')`);
  run(
    raw,
    `INSERT INTO scores (user_id, role, score, core, cover, breakdown_json, formula_version, computed_at) VALUES
       ('u1', 'engineer', 71, 70, 80,
        '{"core":{"gh_eng":{"weight":80,"value":70},"x":{"weight":20,"value":50}},"bonus":{"onchain":{"max":5,"value":91.7}},"cover":80,"level":8,"gaps":{}}',
        'v6', '2026-09-15 10:00:00'),
       ('u1', 'trader', 0, 0, 0, '{"cover":0}', 'v6', '2026-09-15 10:00:00'),
       ('u2', 'engineer', 85, 80, 30, '{"cover":30,"level":9}', 'v6', '2026-09-15 10:00:00')`,
  );
  run(
    raw,
    `INSERT INTO source_facts (user_id, source, facts_json, gap_reason, fetched_at) VALUES
       ('u1', 'x', '{"followers":100}', NULL, '2026-09-15 09:00:00'),
       ('u2', 'x', NULL, 'not configured: TWITTER_TOKEN', '2026-09-15 09:00:00'),
       ('u1', 'github', '{"stars":5}', NULL, '2026-09-15 09:00:00')`,
  );
  run(
    raw,
    `INSERT INTO quality_runs (formula_version, people, exact_pct, near_pct, unscored, report_json, passed, run_at) VALUES
       ('v6', 49, 42.9, 85.7, 2, '{}', 1, '2026-09-12 10:00:00')`,
  );
  return { d1, u1, u2 };
}

describe("loadScoreDistribution", () => {
  it("builds histograms, mean and count per role", async () => {
    const { d1 } = seed();
    const dist = await loadScoreDistribution(d1);
    const engineer = dist.histograms.find((h) => h.role === "engineer");
    expect(engineer).toMatchObject({ count: 2, scoredCount: 2, mean: 78 });
    expect(engineer!.levels[7]).toBe(1); // score 71 -> level 8
    expect(engineer!.levels[8]).toBe(1); // score 85 -> level 9
    const trader = dist.histograms.find((h) => h.role === "trader");
    expect(trader).toMatchObject({ count: 1, scoredCount: 1, mean: 0 });
    expect(trader!.levels[0]).toBe(1); // score 0 -> level 1
  });

  it("counts gaps per source", async () => {
    const { d1 } = seed();
    const dist = await loadScoreDistribution(d1);
    expect(dist.sourceGaps.find((g) => g.source === "x")).toEqual({ source: "x", total: 2, gaps: 1 });
    expect(dist.sourceGaps.find((g) => g.source === "github")).toEqual({ source: "github", total: 1, gaps: 0 });
  });

  it("reads the latest quality run", async () => {
    const { d1 } = seed();
    const dist = await loadScoreDistribution(d1);
    expect(dist.latestQualityRun).toMatchObject({ formulaVersion: "v6", passed: true, exactPct: 42.9, nearPct: 85.7 });
  });

  it("flags level 8+ with low cover, and 0/null score with identities, but not a clean score", async () => {
    const { d1 } = seed();
    const dist = await loadScoreDistribution(d1);
    const byRole = (userId: string, role: string) => dist.suspicious.find((s) => s.userId === userId && s.role === role);
    expect(byRole("u2", "engineer")).toMatchObject({ reason: "low_cover", level: 9, cover: 30 });
    expect(byRole("u1", "trader")).toMatchObject({ reason: "zero_with_identities", score: 0 });
    expect(byRole("u1", "engineer")).toBeUndefined(); // level 8, cover 80: not suspicious
  });
});

describe("searchScoreUsers", () => {
  it("finds a person by email or by X handle, case- and @-insensitive", async () => {
    const { d1 } = seed();
    expect((await searchScoreUsers(d1, "ADA@example.com")).map((h) => h.userId)).toEqual(["u1"]);
    expect((await searchScoreUsers(d1, "@ada")).map((h) => h.userId)).toEqual(["u1"]);
    expect(await searchScoreUsers(d1, "nobody")).toEqual([]);
  });
});

describe("loadUserScoreDetail", () => {
  it("returns null for an unknown user", async () => {
    const { d1 } = seed();
    expect(await loadUserScoreDetail(d1, "nope")).toBeNull();
  });

  it("uses explainRole for each scored role, same as the candidate's own score page", async () => {
    const { d1 } = seed();
    const detail = await loadUserScoreDetail(d1, "u1");
    expect(detail?.identities).toEqual([{ kind: "x", value: "ada", verifiedAt: null }]);
    const engineer = detail?.roles.find((r) => r.role === "engineer")?.view;
    expect(engineer?.state).toBe("scored");
    if (engineer?.state !== "scored") throw new Error("expected a scored role");
    expect(engineer.core.find((c) => c.key === "gh_eng")).toEqual({ key: "gh_eng", label: "GitHub engineering", value: 70, weight: 80 });
    expect(engineer.cover).toBe(80);
    expect(detail?.rawFacts.map((f) => f.source)).toEqual(["github", "x"]);
  });
});

describe("listCandidates", () => {
  it("lists everyone with their best score and level, and filters by email, Telegram or X handle (п.17: /admin/candidates)", async () => {
    const { d1, u1, u2 } = seed();
    const all = await listCandidates(d1);
    expect(all.map((r) => r.userId).sort()).toEqual([u1, u2].sort());
    const ada = all.find((r) => r.userId === u1);
    expect(ada).toMatchObject({ email: "ada@example.com", xHandle: "ada", bestScore: 71, bestLevel: 8 });
    const bob = all.find((r) => r.userId === u2);
    expect(bob).toMatchObject({ email: "bob@example.com", bestScore: 85, bestLevel: 9 });

    expect((await listCandidates(d1, { q: "ADA@example.com" })).map((r) => r.userId)).toEqual([u1]);
    expect((await listCandidates(d1, { q: "@ada" })).map((r) => r.userId)).toEqual([u1]);
    expect(await listCandidates(d1, { q: "nobody" })).toEqual([]);
  });

  it("a person without a score yet has no best score or level", async () => {
    const { raw, d1 } = crmDb();
    const id = addUser(raw, { id: "fresh", email: "fresh@example.com" });
    const rows = await listCandidates(d1);
    expect(rows).toEqual([{ userId: id, email: "fresh@example.com", telegramUsername: null, xHandle: null, createdAt: rows[0]!.createdAt, bestScore: null, bestLevel: null, step: rows[0]!.step }]);
  });
});
