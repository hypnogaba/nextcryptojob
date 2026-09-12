import { describe, expect, it } from "vitest";
import { combine, lin, logn } from "./math.js";

describe("logn і lin", () => {
  it("null на вході дає null, а не 0", () => {
    expect(logn(null, 100)).toBeNull();
    expect(lin(null, 100)).toBeNull();
  });

  it("0 і від'ємне дають 0, стеля й більше дають 1", () => {
    for (const f of [logn, lin]) {
      expect(f(0, 100)).toBe(0);
      expect(f(-5, 100)).toBe(0);
      expect(f(100, 100)).toBe(1);
      expect(f(1e9, 100)).toBe(1);
    }
  });

  it("logn зростає швидше за lin на початку шкали (логарифм винагороджує перші кроки)", () => {
    expect(logn(10, 1000)!).toBeGreaterThan(lin(10, 1000)!);
    expect(logn(10, 1000)!).toBeLessThan(logn(100, 1000)!);
  });
});

describe("combine", () => {
  it("підсигнал-прогалина випадає зі знаменника, а не рахується нулем", () => {
    expect(combine([[50, 1], [50, null]])).toBe(100);
    expect(combine([[50, 1], [50, 0]])).toBe(50);
  });

  it("зважує за вагами", () => {
    expect(combine([[30, 1], [10, 0]])).toBe(75);
  });

  it("усі null або порожньо дає null", () => {
    expect(combine([[10, null], [20, null]])).toBeNull();
    expect(combine([])).toBeNull();
  });
});
