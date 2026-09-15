import { describe, expect, it } from "vitest";
import { crmDb } from "@/test/crm-fixtures";
import { migratedD1 } from "@/test/sqlite-d1";
import { recordFunnelEvent, sumFunnelStep } from "./funnel";

/**
 * funnel_days (D, 0023): +1 за день/крок, сума за діапазон днів, і без винятку,
 * коли міграція 0023 ще не накочена.
 */

describe("recordFunnelEvent + sumFunnelStep", () => {
  it("counts events for the right day and step", async () => {
    const { d1 } = crmDb();
    await recordFunnelEvent(d1, "brief_started", new Date("2026-09-15T10:00:00Z"));
    await recordFunnelEvent(d1, "brief_started", new Date("2026-09-15T11:00:00Z"));
    await recordFunnelEvent(d1, "brief_started", new Date("2026-09-14T10:00:00Z"));
    await recordFunnelEvent(d1, "share_click", new Date("2026-09-15T10:00:00Z"));

    const brief = await sumFunnelStep(d1, "brief_started", "2026-09-15", "2026-09-15");
    expect(brief.total).toBe(2);
    expect(brief.byDay.get("2026-09-15")).toBe(2);

    const wide = await sumFunnelStep(d1, "brief_started", "2026-09-14", "2026-09-15");
    expect(wide.total).toBe(3);

    const share = await sumFunnelStep(d1, "share_click", "2026-09-15", "2026-09-15");
    expect(share.total).toBe(1);
    expect((await sumFunnelStep(d1, "apply_click", "2026-09-15", "2026-09-15")).total).toBe(0);
  });
});

describe("without migration 0023", () => {
  it("recordFunnelEvent does not throw and sumFunnelStep returns 0", async () => {
    const { d1 } = migratedD1();
    await expect(recordFunnelEvent(d1, "brief_started")).resolves.toBeUndefined();
    expect(await sumFunnelStep(d1, "brief_started", "2026-09-01", "2026-09-30")).toEqual({ total: 0, byDay: new Map() });
  });
});
