import { describe, expect, it } from "vitest";
import { freshnessLine } from "./freshness";

const NOW = new Date("2026-09-17T08:00:00Z");
const ms = (iso: string) => Date.parse(iso);

describe("freshnessLine", () => {
  it("says when the job was posted and when we last saw it open", () => {
    expect(freshnessLine({ postedMs: ms("2026-09-03T10:00:00Z"), firstSeenMs: null, checkedMs: ms("2026-09-17T04:40:00Z") }, NOW)).toBe(
      "Posted Sep 3. Still open on Sep 17.",
    );
  });

  it("falls back to the day we first found it when the source gives no date", () => {
    expect(freshnessLine({ postedMs: null, firstSeenMs: ms("2026-09-10T04:40:00Z"), checkedMs: ms("2026-09-16T04:40:00Z") }, NOW)).toBe(
      "Found Sep 10. Still open on Sep 16.",
    );
  });

  it("adds the year for a date from another year", () => {
    expect(freshnessLine({ postedMs: ms("2025-12-20T00:00:00Z"), firstSeenMs: null, checkedMs: null }, NOW)).toBe("Posted Dec 20, 2025.");
  });

  it("never claims a job is open on a day that has not come yet", () => {
    expect(freshnessLine({ postedMs: null, firstSeenMs: null, checkedMs: ms("2026-09-20T00:00:00Z") }, NOW)).toBe("Still open on Sep 17.");
  });

  it("is empty without any date", () => {
    expect(freshnessLine({ postedMs: null, firstSeenMs: null, checkedMs: null }, NOW)).toBeNull();
  });
});
