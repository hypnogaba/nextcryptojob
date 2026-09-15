import { describe, expect, it } from "vitest";
import { addUser, crmDb, run } from "@/test/crm-fixtures";
import { loadFunnelReport } from "./funnel";

/**
 * /admin/funnel (D): visitors → brief started → X added → wallet added → score ready →
 * card viewed → share click → digest active → apply clicks, за вікно днів, з конверсією
 * від попереднього кроку.
 */

const NOW = new Date("2026-09-15T12:00:00Z");

function seed() {
  const { raw, d1 } = crmDb();
  run(
    raw,
    `INSERT INTO visit_days (day, path_group, ref_host, views, uniques) VALUES
       ('2026-09-15', 'home', '', 10, 6),
       ('2026-09-15', 'card', '', 3, 2),
       ('2026-09-14', 'home', '', 5, 4)`,
  );
  run(
    raw,
    `INSERT INTO funnel_days (day, step, count) VALUES
       ('2026-09-15', 'brief_started', 4),
       ('2026-09-14', 'brief_started', 1),
       ('2026-09-15', 'share_click', 2)`,
  );
  const u1 = addUser(raw, { id: "u1", email: "u1@example.com", roles: ["engineer"] });
  const u2 = addUser(raw, { id: "u2", email: "u2@example.com", roles: ["engineer"] });
  const u3 = addUser(raw, { id: "u3", email: "u3@example.com", roles: ["engineer"] });
  const u5 = addUser(raw, { id: "u5", email: "u5@example.com", roles: ["engineer"] });
  const u6 = addUser(raw, { id: "u6", email: "u6@example.com", rolesJson: "[]" });
  const u7 = addUser(raw, { id: "u7", email: "u7@example.com", roles: ["bd"] });
  run(raw, `UPDATE users SET digest_paused = 1 WHERE id = 'u7'`);
  run(
    raw,
    `INSERT INTO identities (user_id, kind, value, created_at) VALUES
       (?, 'x', 'ada', '2026-09-15 09:00:00'),
       (?, 'evm', '0x1111111111111111111111111111111111111111', '2026-09-10 09:00:00'),
       (?, 'solana', 'So11111111111111111111111111111111111111112', '2026-08-01 09:00:00')`,
    u1,
    u2,
    u3,
  );
  run(
    raw,
    `INSERT INTO scores (user_id, role, score, cover, breakdown_json, formula_version, computed_at) VALUES
       (?, 'engineer', 71, 80, '{}', 'v6', '2026-09-15 09:30:00'),
       (?, 'engineer', NULL, 0, '{}', 'v6', '2026-09-15 09:30:00')`,
    u1,
    u5,
  );
  return { d1, u1, u2, u3, u5, u6, u7 };
}

describe("loadFunnelReport", () => {
  it("computes every step for a 7-day window", async () => {
    const { d1 } = seed();
    const report = await loadFunnelReport(d1, 7, NOW);
    const at = (key: string) => report.steps.find((s) => s.key === key)!;
    expect(at("visitors").count).toBe(12); // 6 + 2 + 4 uniques across all path groups
    expect(at("brief_started").count).toBe(5); // 4 + 1
    expect(at("x_added").count).toBe(1); // u1 only, u2/u3 have no X
    expect(at("wallet_added").count).toBe(1); // u2's EVM wallet inside the window; u3's Solana is outside
    expect(at("score_ready").count).toBe(1); // u1 has a non-null score; u5's is null
    expect(at("card_viewed").count).toBe(2); // visit_days path_group = 'card', uniques
    expect(at("share_click").count).toBe(2);
    expect(at("digest_active").count).toBe(4); // u1, u2, u3, u5: roles set, not paused, not demo
    expect(at("apply_click").count).toBe(0);
  });

  it("computes conversion from the previous step, null for the first", async () => {
    const { d1 } = seed();
    const report = await loadFunnelReport(d1, 7, NOW);
    expect(report.steps[0].fromPrev).toBeNull();
    const visitors = report.steps[0].count;
    const briefStarted = report.steps[1].count;
    expect(report.steps[1].fromPrev).toBeCloseTo(briefStarted / visitors, 6);
  });

  it("a 1-day window only sees 15 September", async () => {
    const { d1 } = seed();
    const report = await loadFunnelReport(d1, 1, NOW);
    const at = (key: string) => report.steps.find((s) => s.key === key)!;
    expect(at("brief_started").count).toBe(4);
    expect(at("visitors").count).toBe(8); // 6 + 2
  });
});
