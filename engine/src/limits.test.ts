import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __resetLimiters, backoffFor, budgetKey, budgetKeyForUrl, createLimiter, GITHUB_SEARCH, limiterFor, NestedRunError,
} from "./limits.js";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

beforeEach(() => {
  __resetLimiters();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
});
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

  it("pending() показує, скільки викликів чекає в черзі", async () => {
    const limiter = createLimiter({ concurrency: 2, minIntervalMs: 0 });
    expect(limiter.pending()).toBe(0);
    const calls = Array.from({ length: 5 }, () => limiter.run(() => sleep(10)));
    await vi.advanceTimersByTimeAsync(0);
    expect(limiter.pending()).toBe(3);
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    expect(limiter.pending()).toBe(0);
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
      await sleep(20);
    }));
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    expect(starts).toEqual([0, 50, 100, 150, 200, 250]);
  });
});

describe("createLimiter: backoff", () => {
  it("backoff відсуває наступний старт для всіх слотів бюджету", async () => {
    const limiter = createLimiter({ concurrency: 4, minIntervalMs: 0 });
    const t0 = Date.now();
    limiter.backoff(1_000);
    const starts: number[] = [];
    const calls = Array.from({ length: 4 }, () => limiter.run(async () => { starts.push(Date.now() - t0); }));
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    expect(starts).toEqual([1_000, 1_000, 1_000, 1_000]);
  });

  it("коротший backoff не скорочує вже призначену паузу", async () => {
    const limiter = createLimiter({ concurrency: 1, minIntervalMs: 0 });
    const t0 = Date.now();
    limiter.backoff(2_000);
    limiter.backoff(500);
    let startedAt = -1;
    const p = limiter.run(async () => { startedAt = Date.now() - t0; });
    await vi.runAllTimersAsync();
    await p;
    expect(startedAt).toBe(2_000);
  });

  it("backoff під час очікування продовжує вже взведений таймер", async () => {
    const limiter = createLimiter({ concurrency: 1, minIntervalMs: 100 });
    const t0 = Date.now();
    await limiter.run(async () => undefined);
    let startedAt = -1;
    const p = limiter.run(async () => { startedAt = Date.now() - t0; });
    await vi.advanceTimersByTimeAsync(50);
    limiter.backoff(3_000);   // з моменту t0 + 50
    await vi.runAllTimersAsync();
    await p;
    expect(startedAt).toBe(3_050);
  });

  it("backoffFor приймає адресу й діє на бюджет її хоста", async () => {
    const t0 = Date.now();
    backoffFor("https://api.etherscan.io/v2/api?module=account", 1_500);
    let startedAt = -1;
    const p = limiterFor("etherscan").run(async () => { startedAt = Date.now() - t0; });
    await vi.runAllTimersAsync();
    await p;
    expect(startedAt).toBe(1_500);
  });

  it("backoffFor не чекає довше хвилини, хоч би що попросили", async () => {
    const t0 = Date.now();
    backoffFor("api.github.com", 10 * 60_000);
    let startedAt = -1;
    const p = limiterFor("api.github.com").run(async () => { startedAt = Date.now() - t0; });
    await vi.runAllTimersAsync();
    await p;
    expect(startedAt).toBe(60_000);
  });
});

describe("createLimiter: скасування", () => {
  it("скасований виклик у черзі знімається з неї, fn не викликається, решта йде далі", async () => {
    const limiter = createLimiter({ concurrency: 1, minIntervalMs: 0 });
    const ran: string[] = [];
    const first = limiter.run(async () => { ran.push("a"); await sleep(100); });
    const ac = new AbortController();
    const second = limiter.run(async () => { ran.push("b"); }, { signal: ac.signal });
    const third = limiter.run(async () => { ran.push("c"); });
    await vi.advanceTimersByTimeAsync(0);
    expect(limiter.pending()).toBe(2);
    ac.abort();
    await expect(second).rejects.toMatchObject({ name: "AbortError" });
    expect(limiter.pending()).toBe(1);
    await vi.runAllTimersAsync();
    await Promise.all([first, third]);
    expect(ran).toEqual(["a", "c"]);
  });

  it("уже скасований сигнал відмовляє одразу, без виклику fn", async () => {
    const limiter = createLimiter({ concurrency: 1, minIntervalMs: 0 });
    const fn = vi.fn(async () => 1);
    await expect(limiter.run(fn, { signal: AbortSignal.abort() })).rejects.toMatchObject({ name: "AbortError" });
    expect(fn).not.toHaveBeenCalled();
    expect(limiter.pending()).toBe(0);
  });

  it("скасування після старту не обриває fn: це вже її справа", async () => {
    const limiter = createLimiter({ concurrency: 1, minIntervalMs: 0 });
    const ac = new AbortController();
    const p = limiter.run(async () => { await sleep(10); return "готово"; }, { signal: ac.signal });
    await vi.advanceTimersByTimeAsync(1);
    ac.abort();
    await vi.runAllTimersAsync();
    await expect(p).resolves.toBe("готово");
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

  it("10 000 синхронних відмов поспіль не переповнюють стек", async () => {
    vi.useRealTimers();
    const limiter = createLimiter({ concurrency: 1, minIntervalMs: 0 });
    // Слот зайнятий, тож 10 000 викликів справді стоять у черзі й стартують
    // один за одним, коли він звільниться.
    let open!: () => void;
    const closed = new Promise<void>((r) => { open = r; });
    const gate = limiter.run(() => closed);
    const calls = Array.from({ length: 10_000 }, (_, i) =>
      limiter.run((() => { throw new Error(`#${i}`); }) as () => Promise<never>));
    open();
    await gate;
    const out = await Promise.allSettled(calls);
    expect(out.every((r) => r.status === "rejected" && !(r.reason instanceof RangeError))).toBe(true);
    await expect(limiter.run(async () => "ще живий")).resolves.toBe("ще живий");
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

describe("createLimiter: вкладений run", () => {
  it("run усередині run того самого обмежувача відмовляє зрозумілою помилкою, а не зависає", async () => {
    const limiter = createLimiter({ concurrency: 1, minIntervalMs: 0 });
    const outer = limiter.run(() => limiter.run(async () => 1));
    await expect(outer).rejects.toBeInstanceOf(NestedRunError);
    await expect(limiter.run(async () => 2)).resolves.toBe(2);
  });

  it("вкладений run іншого обмежувача дозволений", async () => {
    const a = createLimiter({ concurrency: 1, minIntervalMs: 0 });
    const b = createLimiter({ concurrency: 1, minIntervalMs: 0 });
    await expect(a.run(() => b.run(async () => "ок"))).resolves.toBe("ок");
  });

  it("послідовні run в одній функції і відкладений виклик після завершення не вважаються вкладеними", async () => {
    const limiter = createLimiter({ concurrency: 1, minIntervalMs: 0 });
    await limiter.run(async () => undefined);
    await expect(limiter.run(async () => "другий")).resolves.toBe("другий");
    let late: Promise<number> | undefined;
    await limiter.run(async () => { setTimeout(() => { late = limiter.run(async () => 7); }, 10); });
    await vi.advanceTimersByTimeAsync(10);
    await expect(late).resolves.toBe(7);
  });

  it("виклик, що чекав у черзі, не успадковує контекст того, хто звільнив слот", async () => {
    const limiter = createLimiter({ concurrency: 1, minIntervalMs: 0 });
    const first = limiter.run(() => sleep(10));
    const second = limiter.run(async () => "без хибної тривоги");
    await vi.runAllTimersAsync();
    await first;
    await expect(second).resolves.toBe("без хибної тривоги");
  });
});

describe("budgetKey і limiterFor", () => {
  it("хост нормалізується: регістр, крапка в кінці, порт", () => {
    expect(budgetKey("API.GitHub.com.")).toBe("api.github.com");
    expect(budgetKey("api.github.com:443")).toBe("api.github.com");
    expect(budgetKey("[2606:4700::1111]:8443")).toBe("2606:4700::1111");
    expect(limiterFor("api.github.com")).toBe(limiterFor("API.GitHub.com.:443"));
  });

  it("різні хости одного провайдера ділять один бюджет", () => {
    expect(budgetKey("eth.blockscout.com")).toBe("blockscout");
    expect(limiterFor("base.blockscout.com")).toBe(limiterFor("api.blockscout.com"));
    expect(limiterFor("mainnet.helius-rpc.com")).toBe(limiterFor("api.helius.xyz"));
    expect(limiterFor("api.etherscan.io")).toBe(limiterFor("etherscan"));
    expect(budgetKey("ai.6551.io")).toBe("6551");
    expect(budgetKey("api.cloudflare.com")).toBe("cloudflare");
  });

  it("схожий, але чужий домен не потрапляє в бюджет провайдера", () => {
    expect(budgetKey("evilblockscout.com")).toBe("evilblockscout.com");
    expect(budgetKey("helius-rpc.com.attacker.net")).toBe("helius-rpc.com.attacker.net");
  });

  it("незнайомі хости не ділять обмежувач між собою", () => {
    expect(limiterFor("a.example.com")).not.toBe(limiterFor("b.example.com"));
    expect(limiterFor("api.github.com")).not.toBe(limiterFor("www.googleapis.com"));
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

describe("бюджети Sherlock, Optimism і пошуку GitHub", () => {
  /** Моменти стартів n викликів одного бюджету (кожен триває 10 мс). */
  async function starts(key: string, n: number): Promise<{ starts: number[]; peak: number }> {
    const limiter = limiterFor(key);
    const out: number[] = [];
    let inFlight = 0, peak = 0;
    const t0 = Date.now();
    const calls = Array.from({ length: n }, () => limiter.run(async () => {
      out.push(Date.now() - t0);
      inFlight++; peak = Math.max(peak, inFlight); await sleep(10); inFlight--;
    }));
    await vi.runAllTimersAsync();
    await Promise.all(calls);
    return { starts: out, peak };
  }
  const gaps = (xs: number[]) => xs.slice(1).map((x, i) => x - xs[i]!);

  it("mainnet-contest.sherlock.xyz: по одному, щонайменше 2,5 с між стартами", async () => {
    const r = await starts("mainnet-contest.sherlock.xyz", 4);
    expect(r.peak).toBe(1);
    for (const g of gaps(r.starts)) expect(g).toBeGreaterThanOrEqual(2_500);
  });

  it("explorer.optimism.io: по одному, 250 мс між стартами, окремо від *.blockscout.com", async () => {
    expect(budgetKey("explorer.optimism.io")).toBe("explorer.optimism.io");
    expect(limiterFor("explorer.optimism.io")).not.toBe(limiterFor("optimism.blockscout.com"));
    const r = await starts("explorer.optimism.io", 4);
    expect(r.peak).toBe(1);
    for (const g of gaps(r.starts)) expect(g).toBeGreaterThanOrEqual(250);
  });

  it("пошук GitHub має свій ключ бюджету з хоста й шляху; GraphQL і core лишаються в api.github.com", () => {
    expect(budgetKeyForUrl("https://api.github.com/search/issues?q=x")).toBe(GITHUB_SEARCH);
    expect(budgetKeyForUrl(new URL("https://API.GitHub.com./search/code"))).toBe(GITHUB_SEARCH);
    expect(budgetKeyForUrl("https://api.github.com/graphql")).toBe("api.github.com");
    expect(budgetKeyForUrl("https://api.github.com/users/x")).toBe("api.github.com");
    expect(budgetKeyForUrl("https://api.github.com/searchx")).toBe("api.github.com");
    // Той самий шлях на чужому хості не потрапляє в бюджет пошуку GitHub.
    expect(budgetKeyForUrl("https://example.com/search/issues")).toBe("example.com");
    expect(budgetKeyForUrl("https://eth.blockscout.com/api?x=1")).toBe("blockscout");
    expect(limiterFor(GITHUB_SEARCH)).not.toBe(limiterFor("api.github.com"));
  });

  it("пошук GitHub: 30 за хвилину (по одному, 2 с між стартами)", async () => {
    const r = await starts(GITHUB_SEARCH, 31);
    expect(r.peak).toBe(1);
    for (const g of gaps(r.starts)) expect(g).toBeGreaterThanOrEqual(2_000);
    expect(r.starts.filter((t) => t < 60_000)).toHaveLength(30);
  });

  it("черга пошуку не гальмує GraphQL: GraphQL стартує одразу, поки пошук чекає свого інтервалу", async () => {
    const search = limiterFor(budgetKeyForUrl("https://api.github.com/search/issues"));
    const graphql = limiterFor(budgetKeyForUrl("https://api.github.com/graphql"));
    const t0 = Date.now();
    const searchStarts: number[] = [];
    const s = Array.from({ length: 5 }, () => search.run(async () => { searchStarts.push(Date.now() - t0); }));
    let graphqlAt = -1;
    const g = graphql.run(async () => { graphqlAt = Date.now() - t0; });
    await vi.runAllTimersAsync();
    await Promise.all([...s, g]);
    expect(graphqlAt).toBe(0);
    expect(searchStarts.at(-1)).toBeGreaterThanOrEqual(8_000);
  });

  it("backoffFor за адресою пошуку відсуває лише пошук, а не весь api.github.com", async () => {
    backoffFor("https://api.github.com/search/issues?q=1", 10_000);
    const t0 = Date.now();
    let graphqlAt = -1, searchAt = -1;
    const g = limiterFor("api.github.com").run(async () => { graphqlAt = Date.now() - t0; });
    const s = limiterFor(GITHUB_SEARCH).run(async () => { searchAt = Date.now() - t0; });
    await vi.runAllTimersAsync();
    await Promise.all([g, s]);
    expect(graphqlAt).toBe(0);
    expect(searchAt).toBeGreaterThanOrEqual(10_000);
  });
});

describe("limiterFor: прибирання незнайомих хостів", () => {
  it("простійний обмежувач незнайомого хоста прибирається, зайнятий лишається", async () => {
    const idle = limiterFor("idle.example.com");
    await idle.run(async () => undefined);
    const busy = limiterFor("busy.example.com");
    const long = busy.run(() => sleep(1_000));
    limiterFor("newcomer.example.com");   // нова адреса запускає прибирання
    expect(limiterFor("idle.example.com")).not.toBe(idle);
    expect(limiterFor("busy.example.com")).toBe(busy);
    await vi.runAllTimersAsync();
    await long;
  });

  it("незнайомий хост під backoff не прибирається, інакше пауза загубилась би", () => {
    const throttled = limiterFor("throttled.example.com");
    throttled.backoff(5_000);
    limiterFor("other.example.com");
    expect(limiterFor("throttled.example.com")).toBe(throttled);
  });

  it("відомі бюджети не прибираються ніколи", async () => {
    const eth = limiterFor("etherscan");
    await eth.run(async () => undefined);
    await vi.advanceTimersByTimeAsync(10_000);
    limiterFor("another.example.com");
    expect(limiterFor("api.etherscan.io")).toBe(eth);
  });
});
