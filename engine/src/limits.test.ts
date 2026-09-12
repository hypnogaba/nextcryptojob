import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLimiter, limiterFor } from "./limits.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }); });
afterEach(() => { vi.useRealTimers(); });

describe("createLimiter: паралелізм", () => {
  it("20 паралельних викликів ніколи не перевищують concurrency, але й використовують її повністю", async () => {
    const limiter = createLimiter({ concurrency: 3, minIntervalMs: 0 });
    let inFlight = 0;
    let peak = 0;
    const calls = Array.from({ length: 20 }, (_, i) => limiter.run(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(10 + (i % 4) * 7);   // різна тривалість, щоб слоти звільнялись не разом
      inFlight--;
      return i;
    }));
    await vi.runAllTimersAsync();
    await expect(Promise.all(calls)).resolves.toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(peak).toBe(3);
    expect(inFlight).toBe(0);
  });

  it("з concurrency 1 наступний не стартує, доки попередній не закінчився", async () => {
    const limiter = createLimiter({ concurrency: 1, minIntervalMs: 0 });
    const log: string[] = [];
    const job = (name: string, ms: number) => limiter.run(async () => {
      log.push(`${name}:start`);
      await sleep(ms);
      log.push(`${name}:end`);
    });
    const all = Promise.all([job("a", 30), job("b", 5), job("c", 1)]);
    await vi.runAllTimersAsync();
    await all;
    expect(log).toEqual(["a:start", "a:end", "b:start", "b:end", "c:start", "c:end"]);
  });
});

describe("createLimiter: інтервал між стартами", () => {
  it("сусідні старти рознесені щонайменше на minIntervalMs, навіть коли слотів вистачає", async () => {
    const limiter = createLimiter({ concurrency: 5, minIntervalMs: 100 });
    const starts: number[] = [];
    const t0 = Date.now();
    const calls = Array.from({ length: 10 }, () => limiter.run(async () => {
      starts.push(Date.now() - t0);
      await sleep(1_000);
    }));
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    expect(starts).toHaveLength(10);
    expect(starts[0]).toBe(0);   // перший не чекає даремно
    for (let i = 1; i < starts.length; i++) {
      expect(starts[i]! - starts[i - 1]!).toBeGreaterThanOrEqual(100);
    }
  });

  it("виклик після довгої паузи стартує одразу", async () => {
    const limiter = createLimiter({ concurrency: 1, minIntervalMs: 250 });
    await limiter.run(async () => undefined);
    await vi.advanceTimersByTimeAsync(1_000);
    const t = Date.now();
    let startedAt = -1;
    const p = limiter.run(async () => { startedAt = Date.now(); });
    await vi.advanceTimersByTimeAsync(0);
    await p;
    expect(startedAt).toBe(t);
  });

  it("інтервал і паралелізм діють разом: слот вільний, але час ще не вийшов", async () => {
    const limiter = createLimiter({ concurrency: 2, minIntervalMs: 50 });
    const starts: number[] = [];
    const t0 = Date.now();
    const calls = Array.from({ length: 6 }, () => limiter.run(async () => {
      starts.push(Date.now() - t0);
      await sleep(20);   // коротше за інтервал: у польоті рідко буває двоє
    }));
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    expect(starts).toEqual([0, 50, 100, 150, 200, 250]);
  });
});

describe("createLimiter: помилки", () => {
  it("відмова fn доходить до викликача і звільняє слот", async () => {
    const limiter = createLimiter({ concurrency: 1, minIntervalMs: 0 });
    const boom = new Error("джерело впало");
    const failing = limiter.run(async () => { await sleep(5); throw boom; });
    const next = limiter.run(async () => "живий");
    const failed = expect(failing).rejects.toBe(boom);
    await vi.runAllTimersAsync();
    await failed;
    await expect(next).resolves.toBe("живий");
  });

  it("синхронний throw у fn теж стає відмовою, а не зависанням черги", async () => {
    const limiter = createLimiter({ concurrency: 1, minIntervalMs: 0 });
    const failing = limiter.run((() => { throw new TypeError("зламано до await"); }) as () => Promise<never>);
    const next = limiter.run(async () => 42);
    await expect(failing).rejects.toBeInstanceOf(TypeError);
    await vi.runAllTimersAsync();
    await expect(next).resolves.toBe(42);
  });

  it("після серії відмов ліміт однаково тримається", async () => {
    const limiter = createLimiter({ concurrency: 2, minIntervalMs: 0 });
    let inFlight = 0;
    let peak = 0;
    const calls = Array.from({ length: 10 }, (_, i) => limiter.run(async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await sleep(10);
      inFlight--;
      if (i % 2 === 0) throw new Error(`#${i}`);
      return i;
    }));
    const settled = Promise.allSettled(calls);
    await vi.runAllTimersAsync();
    const out = await settled;
    expect(out.filter((r) => r.status === "rejected")).toHaveLength(5);
    expect(out.filter((r) => r.status === "fulfilled")).toHaveLength(5);
    expect(peak).toBe(2);
  });

  it("безглузді параметри відкидаються одразу", () => {
    expect(() => createLimiter({ concurrency: 0, minIntervalMs: 0 })).toThrow(RangeError);
    expect(() => createLimiter({ concurrency: 1, minIntervalMs: -1 })).toThrow(RangeError);
  });
});

describe("limiterFor", () => {
  it("один хост ділить один обмежувач, регістр не має значення", () => {
    expect(limiterFor("api.github.com")).toBe(limiterFor("API.GitHub.com"));
    expect(limiterFor("api.github.com")).not.toBe(limiterFor("www.googleapis.com"));
  });

  it("незнайомий хост отримує власний обмежувач, не спільний з іншими незнайомими", () => {
    expect(limiterFor("a.example.com")).not.toBe(limiterFor("b.example.com"));
  });

  it("etherscan пропускає по одному запиту, публічний Solana RPC теж", async () => {
    for (const host of ["api.etherscan.io", "api.mainnet-beta.solana.com"]) {
      const limiter = limiterFor(host);
      let inFlight = 0;
      let peak = 0;
      const calls = Array.from({ length: 4 }, () => limiter.run(async () => {
        inFlight++; peak = Math.max(peak, inFlight); await sleep(10); inFlight--;
      }));
      await vi.runAllTimersAsync();
      await Promise.all(calls);
      expect(peak).toBe(1);
    }
  });

  it("незнайомий хост пропускає кількох паралельно, без пауз між стартами", async () => {
    const limiter = limiterFor("unknown-host.example.org");
    let inFlight = 0;
    let peak = 0;
    const starts: number[] = [];
    const t0 = Date.now();
    const calls = Array.from({ length: 8 }, () => limiter.run(async () => {
      starts.push(Date.now() - t0);
      inFlight++; peak = Math.max(peak, inFlight); await sleep(10); inFlight--;
    }));
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThan(8);
    expect(starts.filter((s) => s === 0).length).toBe(peak);
  });
});
