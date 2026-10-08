import { describe, expect, it } from "vitest";
import { boardJobLocation } from "./format";

describe("boardJobLocation", () => {
  it("adds Remote to a city when the board flags the job remote", () => {
    expect(boardJobLocation("São Paulo", true)).toBe("São Paulo · Remote");
  });
  it("keeps the location as is when it already names the mode or the job is not remote", () => {
    expect(boardJobLocation("Remote - EU", true)).toBe("Remote - EU");
    expect(boardJobLocation("New York - Hybrid", true)).toBe("New York - Hybrid");
    expect(boardJobLocation("Berlin", false)).toBe("Berlin");
  });
  it("falls back to Remote or nothing without a location", () => {
    expect(boardJobLocation("  ", true)).toBe("Remote");
    expect(boardJobLocation(null, false)).toBeNull();
  });
});
