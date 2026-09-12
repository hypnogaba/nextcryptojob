import { describe, expect, it } from "vitest";
import { sqlTime } from "./time";

describe("sqlTime", () => {
  it("writes UTC in the SQLite datetime format", () => {
    const out = sqlTime(new Date("2026-09-12T05:36:07.891Z"));
    expect(out).toBe("2026-09-12 05:36:07");
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("does not depend on the local time zone of the machine", () => {
    // Та сама мить, записана з різним зсувом, дає той самий рядок.
    const a = sqlTime(new Date("2026-09-12T08:00:00+03:00"));
    const b = sqlTime(new Date("2026-09-12T05:00:00Z"));
    expect(a).toBe(b);
  });

  it("compares correctly as text against datetime('now') strings", () => {
    // Так порівнює SQL: expires_at > datetime('now') посимвольно.
    const now = "2026-09-12 10:00:00";
    const expired = sqlTime(new Date("2026-09-12T09:59:59Z"));
    const valid = sqlTime(new Date("2026-09-12T10:00:01Z"));
    expect(expired < now).toBe(true);
    expect(valid > now).toBe(true);
  });

  it("avoids the ISO trap where an expired time looks valid", () => {
    // ISO-рядок з 'T' сортується після будь-якого ' ' того самого дня.
    const now = "2026-09-12 10:00:00";
    const expiredIso = new Date("2026-09-12T09:00:00Z").toISOString();
    expect(expiredIso > now).toBe(true);
    expect(sqlTime(new Date(expiredIso)) > now).toBe(false);
  });
});
