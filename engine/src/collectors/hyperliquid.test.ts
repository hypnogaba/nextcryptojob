import { beforeEach, describe, expect, it } from "vitest";
import { __resetLimiters } from "../limits.js";
import { allTimeVolume, collectHyperliquid } from "./hyperliquid.js";

const A = "0xabc" + "1".repeat(37);
const B = "0xdef" + "2".repeat(37);

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
type Call = { url: string; method: string; body: { type: string; user: string }; contentType: string | null };
function fake(route: (c: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = (async (u: string | URL | Request, init?: RequestInit) => {
    const c: Call = {
      url: String(u), method: String(init?.method), body: JSON.parse(String(init?.body)),
      contentType: new Headers(init?.headers).get("content-type"),
    };
    calls.push(c);
    return route(c);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

// Форма відповіді portfolio: масив пар [період, {accountValueHistory, pnlHistory, vlm}].
const period = (vlm: string) => ({ accountValueHistory: [[1789103160010, "10.5"]], pnlHistory: [[1789103160010, "0.0"]], vlm });
const portfolio = (allTime: string | null) => [
  ["day", period("0.0")], ["week", period("12.5")], ["month", period("100.0")],
  ...(allTime === null ? [] : [["allTime", period(allTime)]]),
  ["perpDay", period("0.0")], ["perpAllTime", period("999.0")],
];
const fill = (i: number) => ({ coin: "BTC", px: "60000.0", sz: "0.001", side: i % 2 ? "A" : "B", time: 1779321600086 - i, dir: "Open Long", closedPnl: "0.0", hash: "0x" + "0".repeat(64), oid: i, crossed: true, fee: "0.01", tid: i, feeToken: "USDC" });

beforeEach(() => { __resetLimiters(); });

describe("allTimeVolume", () => {
  it("бере allTime.vlm, а не perpAllTime чи інші періоди", () => {
    expect(allTimeVolume(portfolio("36712.84"))).toBe(36712.84);
  });
  it("немає allTime, не масив, не число: null", () => {
    expect(allTimeVolume(portfolio(null))).toBeNull();
    expect(allTimeVolume({ error: "x" })).toBeNull();
    expect(allTimeVolume([["allTime", { vlm: "abc" }]])).toBeNull();
    expect(allTimeVolume([["allTime", {}]])).toBeNull();
  });
  it("нуль обсягу: це відповідь, 0", () => {
    expect(allTimeVolume(portfolio("0.0"))).toBe(0);
  });
});

describe("collectHyperliquid", () => {
  it("обсяг з portfolio, угоди = довжина userFills; POST JSON з адресою в нижньому регістрі", async () => {
    const { fetchImpl, calls } = fake((c) => c.body.type === "portfolio" ? json(portfolio("36712.84")) : json(Array.from({ length: 86 }, (_, i) => fill(i))));
    const res = await collectHyperliquid([A.toUpperCase().replace("0X", "0x")], { fetchImpl, retries: 0 });
    expect(res).toEqual({ ok: true, facts: { [A]: { volumeUsd: 36712.84, fillsRecent: 86 } } });
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.url).toBe("https://api.hyperliquid.xyz/info");
      expect(c.method).toBe("POST");
      expect(c.contentType).toBe("application/json");
      expect(c.body.user).toBe(A);
    }
    expect(calls.map((c) => c.body.type).sort()).toEqual(["portfolio", "userFills"]);
  });

  it("новий гаманець: нульовий обсяг і нуль угод (відповіді, не прогалини)", async () => {
    const { fetchImpl } = fake((c) => c.body.type === "portfolio" ? json(portfolio("0.0")) : json([]));
    expect(await collectHyperliquid([A], { fetchImpl })).toEqual({ ok: true, facts: { [A]: { volumeUsd: 0, fillsRecent: 0 } } });
  });

  it("portfolio не відповів: обсяг null, угоди лишаються", async () => {
    const { fetchImpl } = fake((c) => c.body.type === "portfolio" ? new Response("x", { status: 500 }) : json([fill(1)]));
    const res = await collectHyperliquid([A], { fetchImpl, retries: 0, retryDelayMs: 0 });
    expect(res).toEqual({ ok: true, facts: { [A]: { volumeUsd: null, fillsRecent: 1 } } });
  });

  it("одна адреса не відповіла зовсім: поля null і partial; усі не відповіли: прогалина", async () => {
    const { fetchImpl } = fake((c) => c.body.user === B ? new Response("x", { status: 500 }) : c.body.type === "portfolio" ? json(portfolio("5")) : json([]));
    const res = await collectHyperliquid([A, B], { fetchImpl, retries: 0, retryDelayMs: 0 });
    if (!res.ok) throw new Error(res.gap);
    expect(res.facts[B]).toEqual({ volumeUsd: null, fillsRecent: null });
    expect(res.partial?.[B]).toMatch(/api\.hyperliquid\.xyz/);
    expect(res.facts[A]).toEqual({ volumeUsd: 5, fillsRecent: 0 });

    const down = fake(() => new Response("x", { status: 502 }));
    const gap = await collectHyperliquid([A], { fetchImpl: down.fetchImpl, retries: 0, retryDelayMs: 0 });
    expect(gap.ok).toBe(false);
    if (!gap.ok) expect(gap.gap).toMatch(/^Hyperliquid: /);
  });

  it("неправильна адреса не йде в мережу", async () => {
    const { fetchImpl, calls } = fake(() => json([]));
    expect(await collectHyperliquid(["nope"], { fetchImpl })).toEqual({ ok: false, gap: "no valid EVM address" });
    expect(await collectHyperliquid([], { fetchImpl })).toEqual({ ok: true, facts: {} });
    expect(calls).toHaveLength(0);
  });
});
