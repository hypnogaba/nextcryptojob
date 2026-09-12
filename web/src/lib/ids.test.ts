import { describe, expect, it } from "vitest";
import { newPaymentId } from "@/lib/x402/server";
import { ID_PREFIXES, isId, newId, randomBase62 } from "./ids";

describe("newId", () => {
  it.each(ID_PREFIXES)("gives %s_ + 20 base62 characters", (prefix) => {
    const id = newId(prefix);
    expect(id).toMatch(new RegExp(`^${prefix}_[0-9A-Za-z]{20}$`));
    expect(isId(prefix, id)).toBe(true);
  });

  it("never repeats in 10 000 draws", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId("co")));
    expect(ids.size).toBe(10_000);
  });

  it("uses the whole alphabet with no visibly favoured characters", () => {
    const counts = new Map<string, number>();
    for (const ch of randomBase62(62_000)) counts.set(ch, (counts.get(ch) ?? 0) + 1);
    expect(counts.size).toBe(62);
    // 1 000 в середньому; модульне зміщення без відкидання дало б +25% першим 8 символам.
    for (const n of counts.values()) {
      expect(n).toBeGreaterThan(800);
      expect(n).toBeLessThan(1200);
    }
  });

  it("x402 payment ids come from the same generator", () => {
    expect(isId("pay", newPaymentId())).toBe(true);
  });
});

describe("isId", () => {
  it("rejects other prefixes, wrong lengths and non-base62 characters", () => {
    const body = "A".repeat(20);
    expect(isId("job", `co_${body}`)).toBe(false);
    expect(isId("job", `job_${body}A`)).toBe(false);
    expect(isId("job", `job_${"A".repeat(19)}`)).toBe(false);
    expect(isId("job", `job_${"A".repeat(19)}-`)).toBe(false);
    expect(isId("job", null)).toBe(false);
    expect(isId("job", `job_${body}`)).toBe(true);
  });
});
