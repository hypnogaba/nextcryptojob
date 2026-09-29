import { describe, expect, it } from "vitest";
import { crmDb, run } from "@/test/crm-fixtures";
import { migratedD1 } from "@/test/sqlite-d1";
import { loadFunnelMessages } from "./funnel-messages";

const NOW = new Date("2026-09-29T12:00:00Z");

describe("loadFunnelMessages", () => {
  it("counts each message kind for 7 and 30 days, the yes answers and the votes", async () => {
    const t = crmDb();
    for (const id of ["a", "b", "c"]) run(t.raw, "INSERT INTO users (id, email) VALUES (?, ?)", id, `${id}@example.com`);
    const nudge = (user: string, kind: string, sentAt: string, answered: string | null = null) =>
      run(t.raw, "INSERT INTO nudges (user_id, kind, sent_at, answered_at) VALUES (?, ?, ?, ?)", user, kind, sentAt, answered);
    nudge("a", "still_looking", "2026-09-27 10:00:00", "2026-09-27 11:00:00");
    nudge("b", "still_looking", "2026-09-10 10:00:00");
    nudge("c", "still_looking", "2026-07-01 10:00:00"); // старіше за 30 днів
    nudge("a", "empty_week", "2026-09-28 10:00:00");
    nudge("b", "inactive_pause", "2026-09-20 10:00:00");
    run(t.raw, "INSERT INTO job_feedback (user_id, job_ref, vote, at) VALUES ('a', 'nr:1', 'down', '2026-09-20 10:00:00'), ('a', 'nr:2', 'up', '2026-09-21 10:00:00'), ('b', 'nr:1', 'down', '2026-09-22 10:00:00'), ('c', 'nr:1', 'down', '2026-06-01 10:00:00')");
    const f = await loadFunnelMessages(t.d1, NOW);
    expect(f).toMatchObject({
      stillLooking: { d7: 1, d30: 2 },
      stillAnswered: 1,
      emptyWeek: { d7: 1, d30: 1 },
      inactivePaused: { d7: 0, d30: 1 },
      onboardingReminders: { d7: 0, d30: 0 },
      blockedNotices: { d7: 0, d30: 0 },
      thumbsDown: 2,
      thumbsUp: 1,
      voters: 2,
    });
  });

  it("is null, not an error, before migration 0028 is applied", async () => {
    expect(await loadFunnelMessages(migratedD1(["0001_core.sql"]).d1, NOW)).toBeNull();
  });
});
