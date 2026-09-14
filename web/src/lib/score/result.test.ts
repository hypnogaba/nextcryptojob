import { describe, expect, it } from "vitest";
import type { ScoreRow } from "./explain";
import { improvements, nextPollStep, pollDelayMs, rankRoles } from "./result";
import type { ProfileStatus } from "./status";

const status = (job: ProfileStatus["job"], sourcesChanged = false, scored = false): ProfileStatus => ({ job, scored, sourcesChanged });
const row = (role: string, score: number | null): ScoreRow => ({
  role,
  score,
  breakdown_json: "{}",
  formula_version: "v6",
  computed_at: "2026-09-14 10:00:00",
});

describe("nextPollStep: the 'Scoring your work…' page", () => {
  it("queues a score when there was none, or when sources changed after the last one", () => {
    expect(nextPollStep(status(null))).toBe("enqueue");
    expect(nextPollStep(status({ status: "done", waitedSeconds: 30 }, true, true))).toBe("enqueue");
    // Упало, але з того часу щось змінилось: пробуємо знову, а не показуємо помилку.
    expect(nextPollStep(status({ status: "failed", waitedSeconds: 30 }, true))).toBe("enqueue");
  });

  it("waits while the job is queued or running, even if sources changed meanwhile", () => {
    expect(nextPollStep(status({ status: "queued", waitedSeconds: 2 }))).toBe("wait");
    expect(nextPollStep(status({ status: "running", waitedSeconds: 5 }, true))).toBe("wait");
  });

  it("shows the result once the last job is done and nothing changed since", () => {
    expect(nextPollStep(status({ status: "done", waitedSeconds: 8 }, false, true))).toBe("done");
    expect(nextPollStep(status({ status: "failed", waitedSeconds: 60 }))).toBe("failed");
  });

  it("polls often at first and less later", () => {
    expect(pollDelayMs(0)).toBe(2_000);
    expect(pollDelayMs(60_000)).toBe(4_000);
    expect(pollDelayMs(300_000)).toBe(8_000);
  });
});

describe("rankRoles: which score goes on the first card", () => {
  const scores = new Map([
    ["bd", row("bd", 44.6)],
    ["marketing_content", row("marketing_content", 61.2)],
    ["trader", row("trader", 13.1)],
    ["engineer", row("engineer", null)],
    ["designer", row("designer", 50)],
  ]);

  it("the person's roles with a score, highest first, whole numbers and levels", () => {
    expect(rankRoles(["bd", "marketing_content", "engineer"], scores)).toEqual([
      { role: "marketing_content", score: 61, level: 7 },
      { role: "bd", score: 44, level: 5 },
    ]);
  });

  it("ignores roles the person did not pick and roles that have no score yet", () => {
    expect(rankRoles(["engineer", "designer"], scores)).toEqual([]);
  });

  it("keeps the person's order on a tie", () => {
    const tie = new Map([["bd", row("bd", 40)], ["community", row("community", 40)]]);
    expect(rankRoles(["community", "bd"], tie).map((r) => r.role)).toEqual(["community", "bd"]);
  });
});

describe("improvements: what raises the score", () => {
  it("asks for wallets up to 10, then GitHub, a site and YouTube, and never for a second X", () => {
    expect(improvements([{ kind: "x" }]).map((i) => i.key)).toEqual(["wallets", "github", "site", "youtube"]);
    const two = improvements([{ kind: "x" }, { kind: "evm" }, { kind: "solana" }, { kind: "github" }]);
    expect(two.map((i) => i.key)).toEqual(["wallets", "site", "youtube"]);
    expect(two[0]!.text).toBe("Add more wallets: you have 2 of 10. Each one adds its history.");
  });

  it("stops asking for wallets at 10", () => {
    const ten = Array.from({ length: 10 }, () => ({ kind: "evm" as const }));
    expect(improvements([{ kind: "x" }, ...ten, { kind: "github" }, { kind: "site" }, { kind: "youtube" }])).toEqual([]);
  });
});
