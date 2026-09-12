import { describe, expect, it } from "vitest";
import { addNote, budgetFor, DEADLINE_MARGIN_MS, inBandDelay } from "./onchain.js";

describe("budgetFor: межа часу на людину", () => {
  it("нова робота стартує лише до deadline − 10 с", () => {
    let t = 1_000;
    const b = budgetFor({ now: () => t, deadline: 1_000 + 45_000 });
    expect(b.open()).toBe(true);
    t = 1_000 + 45_000 - DEADLINE_MARGIN_MS - 1;
    expect(b.open()).toBe(true);
    t += 1;
    expect(b.open()).toBe(false);
    expect(b.stopped()).toBe(false);
  });

  it("без явного deadline бере ENGINE_DEADLINE_MS від старту, типово 45 с", () => {
    let t = 0;
    const custom = budgetFor({ now: () => t, env: { ENGINE_DEADLINE_MS: "20000" } });
    t = 9_999;
    expect(custom.open()).toBe(true);
    t = 10_000;
    expect(custom.open()).toBe(false);

    t = 0;
    const def = budgetFor({ now: () => t, env: {} });
    t = 34_999;
    expect(def.open()).toBe(true);
    t = 35_000;
    expect(def.open()).toBe(false);
  });

  it("сигнал бюджету сам обриває запити за 2 с до deadline; це не скасування викликачем", async () => {
    const b = budgetFor({ deadline: Date.now() + 2_150, deadlineMarginMs: 0 });
    expect(b.signal.aborted).toBe(false);
    await new Promise((r) => setTimeout(r, 400));
    expect(b.signal.aborted).toBe(true);
    expect(b.stopped()).toBe(true);
    expect(b.open()).toBe(false);
  });

  it("скасування викликачем проходить у сигнал, але stopped() = false", () => {
    const ac = new AbortController();
    const b = budgetFor({ signal: ac.signal, deadline: Date.now() + 60_000 });
    ac.abort();
    expect(b.signal.aborted).toBe(true);
    expect(b.stopped()).toBe(false);
  });
});

describe("ліміт у тілі відповіді", () => {
  it("паузи між повторами 1, 2, 4 с (кількість повторів перевіряє evm.test)", () => {
    expect([0, 1, 2].map((a) => inBandDelay(1_000, a))).toEqual([1_000, 2_000, 4_000]);
  });
});

describe("addNote", () => {
  it("кілька приміток однієї адреси склеюються", () => {
    const p: Record<string, string> = {};
    addNote(p, "A", "swaps: not configured: HELIUS_KEY");
    addNote(p, "A", "sigs: stopped early: deadline");
    expect(p).toEqual({ A: "swaps: not configured: HELIUS_KEY; sigs: stopped early: deadline" });
  });
});
