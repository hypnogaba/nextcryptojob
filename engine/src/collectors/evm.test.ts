import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetLimiters } from "../limits.js";
import { collectEvm, type EvmChain, type EvmOptions } from "./evm.js";
import { __resetSelectorCaches } from "./selectors.js";

// Синтетичні відповіді за формою Etherscan v2 / Blockscout txlist і openchain.
const ADDR = "0xabc" + "1".repeat(37);
const OTHER = "0x2222222222222222222222222222222222222222";
const KEY = "ES-SECRET-KEY-123";
const BS_KEY = "proapi_SECRET456";

type Row = Record<string, string>;
let seq = 0;
const row = (o: { from?: string; ts?: number; block?: number; methodId?: string; functionName?: string; isError?: string; blockscout?: boolean } = {}): Row => {
  const r: Row = {
    blockNumber: String(o.block ?? 100), timeStamp: String(o.ts ?? 1_700_000_000), hash: `0x${(seq++).toString(16).padStart(64, "0")}`,
    nonce: "1", from: o.from ?? ADDR, to: OTHER, value: "0", gas: "21000", gasPrice: "1", input: o.methodId && o.methodId !== "0x" ? o.methodId + "00" : "0x",
    methodId: o.methodId ?? "0x", isError: o.isError ?? "0", txreceipt_status: o.isError === "1" ? "0" : "1",
    contractAddress: "", cumulativeGasUsed: "1", gasUsed: "21000", confirmations: "10",
  };
  if (!o.blockscout) r.functionName = o.functionName ?? "";
  return r;
};

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
const NO_TX = { status: "0", message: "No transactions found", result: [] };

type Handler = (p: URLSearchParams, init?: RequestInit) => Response | Promise<Response>;
/**
 * Рядки від найновішого до найстарішого; віддає сторінку за page/offset/sort як txlist.
 * startblock/endblock фільтрують, як на Blockscout.
 */
const paged = (rows: Row[]): Handler => (p) => {
  const page = Number(p.get("page")), offset = Number(p.get("offset"));
  if (page * offset > 10_000) return json({ status: "0", message: "Result window is too large, PageNo x Offset size must be less than or equal to 10000", result: null });
  const lo = Number(p.get("startblock") ?? 0), hi = Number(p.get("endblock") ?? Infinity);
  const inRange = rows.filter((r) => Number(r.blockNumber) >= lo && Number(r.blockNumber) <= hi);
  const ordered = p.get("sort") === "asc" ? [...inRange].reverse() : inRange;
  const slice = ordered.slice((page - 1) * offset, page * offset);
  return json(slice.length ? { status: "1", message: "OK", result: slice } : NO_TX);
};

function chainOf(u: URL): EvmChain | "openchain" {
  const byId: Record<string, EvmChain> = { "1": "ethereum", "8453": "base", "42161": "arbitrum", "10": "optimism" };
  switch (u.hostname) {
    case "api.etherscan.io": return byId[u.searchParams.get("chainid")!]!;
    case "api.blockscout.com": return byId[u.searchParams.get("chain_id")!]!;
    case "eth.blockscout.com": return "ethereum";
    case "base.blockscout.com": return "base";
    case "arbitrum.blockscout.com": return "arbitrum";
    case "explorer.optimism.io": return "optimism";
    case "api.openchain.xyz": return "openchain";
    default: throw new Error(`несподіваний хост ${u.hostname}`);
  }
}

const OPENCHAIN_NAMES: Record<string, string> = {
  "0x38ed1739": "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
  "0x3593564c": "execute(bytes,bytes[],uint256)",
  "0x095ea7b3": "approve(address,uint256)",
};
const openchainOk: Handler = (p) => {
  const fn: Record<string, unknown> = {};
  for (const s of (p.get("function") ?? "").split(",")) fn[s] = OPENCHAIN_NAMES[s] ? [{ name: OPENCHAIN_NAMES[s], filtered: false }] : null;
  return json({ ok: true, result: { function: fn, event: {} } });
};

type Call = { url: URL; chain: string; at: number };
function router(h: Partial<Record<EvmChain | "openchain", Handler>>) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const chain = chainOf(url);
    calls.push({ url, chain, at: performance.now() });
    const handler = h[chain] ?? (chain === "openchain" ? openchainOk : () => json(NO_TX));
    return handler(url.searchParams, init);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, of: (c: string) => calls.filter((x) => x.chain === c) };
}

let dir: string;
const opts = (fetchImpl: typeof fetch, env: Record<string, string> = { ETHERSCAN_KEY: KEY }): EvmOptions =>
  ({ fetchImpl, env, retries: 0, retryDelayMs: 0, rateLimitBackoffMs: 10, selectorCachePath: join(dir, "selectors.json") });

beforeEach(async () => {
  __resetLimiters();
  __resetSelectorCaches();
  dir = await mkdtemp(join(tmpdir(), "ncj-evm-"));
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("collectEvm: сторінки й лічба", () => {
  it("Etherscan: сторінки по 1000, надіслані лише від адреси, вік з найстарішого рядка", async () => {
    const rows = Array.from({ length: 2500 }, (_, i) => row({ from: i % 2 ? OTHER : ADDR, ts: 1_700_000_000 - i }));
    const base = [row({ ts: 1_710_000_000, blockscout: true }), row({ from: OTHER, ts: 1_690_000_000, blockscout: true })];
    const r = router({ ethereum: paged(rows), base: paged(base) });
    const res = await collectEvm(["0x" + ADDR.slice(2).toUpperCase()], opts(r.fetchImpl));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.facts[ADDR]!.ethereum).toEqual({ sent: 1250, sentCapped: false, firstTs: 1_700_000_000 - 2499, swaps: 0, source: "etherscan" });
    expect(res.facts[ADDR]!.base).toEqual({ sent: 1, sentCapped: false, firstTs: 1_690_000_000, swaps: 0, source: "blockscout" });
    // Порожня мережа: нуль надісланих є відповіддю, а вік невідомий.
    expect(res.facts[ADDR]!.arbitrum).toEqual({ sent: 0, sentCapped: false, firstTs: null, swaps: 0, source: "etherscan" });

    const eth = r.of("ethereum");
    expect(eth.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "2", "3"]);
    for (const c of eth) {
      expect(c.url.origin + c.url.pathname).toBe("https://api.etherscan.io/v2/api");
      expect(c.url.searchParams.get("offset")).toBe("1000");
      expect(c.url.searchParams.get("sort")).toBe("desc");
      expect(c.url.searchParams.get("apikey")).toBe(KEY);
      expect(c.url.searchParams.get("action")).toBe("txlist");
      expect(c.url.searchParams.get("address")).toBe(ADDR);
    }
    // Base без BLOCKSCOUT_KEY: публічний сервер (задокументований запасний шлях).
    expect(r.of("base")[0]!.url.origin).toBe("https://base.blockscout.com");
    expect(r.of("optimism")[0]!.url.origin).toBe("https://explorer.optimism.io");
  });

  it("10 000 рядків: sentCapped і один додатковий запит asc offset=1 за віком", async () => {
    const rows = Array.from({ length: 10_500 }, (_, i) => row({ ts: 1_700_000_000 - i }));
    const r = router({ ethereum: paged(rows) });
    const res = await collectEvm([ADDR], opts(r.fetchImpl));
    if (!res.ok) throw new Error(res.gap);
    expect(res.facts[ADDR]!.ethereum).toMatchObject({ sent: 10_000, sentCapped: true, firstTs: 1_700_000_000 - 10_499 });
    const eth = r.of("ethereum");
    expect(eth).toHaveLength(11);
    const last = eth.at(-1)!.url.searchParams;
    expect([last.get("sort"), last.get("page"), last.get("offset")]).toEqual(["asc", "1", "1"]);
  }, 20_000);

  it("збій посеред сторінок: лічба як нижня межа, прогалина з причиною, вік окремим запитом", async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => row({ ts: 1_700_000_000 - i }));
    const ok = paged(rows);
    const r = router({ ethereum: (p) => p.get("page") === "2" && p.get("sort") === "desc" ? new Response("bad gateway", { status: 502 }) : ok(p) });
    const res = await collectEvm([ADDR], opts(r.fetchImpl));
    if (!res.ok) throw new Error(res.gap);
    const eth = res.facts[ADDR]!.ethereum!;
    expect(eth).toMatchObject({ sent: 1000, sentCapped: true, firstTs: 1_700_000_000 - 1499, swaps: 0 });
    expect(eth.gap).toMatch(/partial: page 2 failed/);
  });

  it("свіжі транзакції з блоків понад 99 999 999 рахуються (Optimism, Arbitrum)", async () => {
    const op = [row({ block: 156_129_793, ts: 1_787_858_363, blockscout: true }), row({ block: 94_168_674, ts: 1_700_000_000, blockscout: true })];
    const arb = [row({ block: 499_023_167, ts: 1_787_000_000 })];
    const r = router({ optimism: paged(op), arbitrum: paged(arb) });
    const res = await collectEvm([ADDR], opts(r.fetchImpl));
    if (!res.ok) throw new Error(res.gap);
    expect(res.facts[ADDR]!.optimism).toMatchObject({ sent: 2, firstTs: 1_700_000_000 });
    expect(res.facts[ADDR]!.arbitrum).toMatchObject({ sent: 1 });
  });

  it("той самий рядок на межі сторінок рахується раз", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => row({ ts: 1_700_000_000 - i }));
    // Нова транзакція між запитами зсунула сторінку 2 на один рядок назад.
    const r = router({ ethereum: (p) => p.get("page") === "2" ? json({ status: "1", message: "OK", result: rows.slice(999) }) : paged(rows)(p) });
    const res = await collectEvm([ADDR], opts(r.fetchImpl));
    if (!res.ok) throw new Error(res.gap);
    expect(res.facts[ADDR]!.ethereum!.sent).toBe(1200);
  });
});

describe("collectEvm: прогалини й ключі", () => {
  it("мережа, що не відповіла, має gap; решта мереж адреси лишаються", async () => {
    const r = router({
      ethereum: paged([row()]),
      base: () => new Response("unavailable", { status: 503 }),
    });
    const res = await collectEvm([ADDR], opts(r.fetchImpl));
    if (!res.ok) throw new Error(res.gap);
    expect(res.facts[ADDR]!.ethereum!.sent).toBe(1);
    const base = res.facts[ADDR]!.base!;
    expect(base).toMatchObject({ sent: null, sentCapped: false, firstTs: null, swaps: null, source: "blockscout" });
    expect(base.gap).toMatch(/^not configured: BLOCKSCOUT_KEY; public base\.blockscout\.com failed: /);
  });

  it("з BLOCKSCOUT_KEY Base і Optimism ідуть у PRO API з chain_id і apikey", async () => {
    const r = router({ base: paged([row({ blockscout: true })]) });
    const res = await collectEvm([ADDR], opts(r.fetchImpl, { ETHERSCAN_KEY: KEY, BLOCKSCOUT_KEY: BS_KEY }));
    if (!res.ok) throw new Error(res.gap);
    const [b] = r.of("base");
    expect(b!.url.origin + b!.url.pathname).toBe("https://api.blockscout.com/v2/api");
    expect(b!.url.searchParams.get("chain_id")).toBe("8453");
    expect(b!.url.searchParams.get("apikey")).toBe(BS_KEY);
    expect(r.of("optimism")[0]!.url.searchParams.get("chain_id")).toBe("10");
    expect(r.of("ethereum")[0]!.url.hostname).toBe("api.etherscan.io");
    expect(res.facts[ADDR]!.base).toMatchObject({ sent: 1, source: "blockscout" });
  });

  it("без ETHERSCAN_KEY Ethereum і Arbitrum ідуть у Blockscout; збій = not configured: ETHERSCAN_KEY", async () => {
    const r = router({
      ethereum: () => new Response("<title>Just a moment...</title>", { status: 403, headers: { "content-type": "text/html" } }),
      arbitrum: paged([row({ blockscout: true })]),
    });
    const res = await collectEvm([ADDR], opts(r.fetchImpl, {}));
    if (!res.ok) throw new Error(res.gap);
    expect(r.of("ethereum")[0]!.url.origin).toBe("https://eth.blockscout.com");
    expect(res.facts[ADDR]!.ethereum!.gap).toMatch(/^not configured: ETHERSCAN_KEY; public eth\.blockscout\.com failed: .*403/);
    expect(res.facts[ADDR]!.arbitrum).toMatchObject({ sent: 1, source: "blockscout" });
    expect(r.calls.some((c) => c.url.hostname === "api.etherscan.io")).toBe(false);
  });

  it("без ETHERSCAN_KEY, але з BLOCKSCOUT_KEY Ethereum іде в PRO API з chain_id=1", async () => {
    const r = router({});
    await collectEvm([ADDR], opts(r.fetchImpl, { BLOCKSCOUT_KEY: BS_KEY }));
    expect(r.of("ethereum")[0]!.url.searchParams.get("chain_id")).toBe("1");
    expect(r.of("arbitrum")[0]!.url.searchParams.get("chain_id")).toBe("42161");
  });

  it("жодна мережа жодної адреси не відповіла: прогалина всього джерела", async () => {
    const down = () => new Response("down", { status: 500 });
    const r = router({ ethereum: down, base: down, arbitrum: down, optimism: down });
    const res = await collectEvm([ADDR], opts(r.fetchImpl));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.gap).toMatch(/^EVM: no chain answered/);
    expect(res.gap).toContain("base: not configured: BLOCKSCOUT_KEY");
  });

  it("ключ не потрапляє ні в gap, ні в факти", async () => {
    const r = router({
      ethereum: () => json({ status: "0", message: "NOTOK", result: `Invalid API Key (#err2) ${KEY}` }),
      arbitrum: () => { throw new TypeError(`fetch failed: https://api.etherscan.io/v2/api?apikey=${KEY}`); },
    });
    const res = await collectEvm([ADDR], opts(r.fetchImpl));
    expect(JSON.stringify(res)).not.toContain(KEY);
    if (!res.ok) throw new Error(res.gap);
    expect(res.facts[ADDR]!.ethereum!.gap).toMatch(/api\.etherscan\.io: Invalid API Key/);
    expect(res.facts[ADDR]!.arbitrum!.gap).toBeTruthy();
  });

  it("ліміт у тілі (200 + Max rate limit reached): бюджет відсувається, та сама сторінка повторюється", async () => {
    let limited = 1;
    const r = router({
      ethereum: (p) => limited-- > 0
        ? json({ status: "0", message: "NOTOK", result: "Max calls per sec rate limit reached (3/sec)" })
        : paged([row()])(p),
    });
    const res = await collectEvm([ADDR], { ...opts(r.fetchImpl), rateLimitBackoffMs: 600 });
    if (!res.ok) throw new Error(res.gap);
    expect(res.facts[ADDR]!.ethereum!.sent).toBe(1);
    const eth = r.of("ethereum");
    expect(eth.map((c) => c.url.searchParams.get("page"))).toEqual(["1", "1"]);
    // Між спробами щонайменше пауза бюджету (600 мс), а не звичайний інтервал Etherscan (250 мс).
    expect(eth[1]!.at - eth[0]!.at).toBeGreaterThanOrEqual(550);
  });

  it("ліміт у тілі щоразу: не більше трьох повторів, далі прогалина мережі", async () => {
    const r = router({ ethereum: () => json({ status: "0", message: "NOTOK", result: "Max rate limit reached" }) });
    const res = await collectEvm([ADDR], opts(r.fetchImpl));
    if (!res.ok) throw new Error(res.gap);
    expect(r.of("ethereum")).toHaveLength(4);
    expect(res.facts[ADDR]!.ethereum!.gap).toMatch(/Max rate limit reached/);
  });

  it("5xx: типово один повтор, а не більше", async () => {
    let n = 0;
    const flaky = router({ ethereum: (p) => (n++ === 0 ? new Response("x", { status: 502 }) : paged([row()])(p)) });
    const ok = await collectEvm([ADDR], { ...opts(flaky.fetchImpl), retries: undefined });
    if (!ok.ok) throw new Error(ok.gap);
    expect(ok.facts[ADDR]!.ethereum!.sent).toBe(1);

    __resetLimiters();
    const down = router({ ethereum: () => new Response("x", { status: 502 }) });
    const res = await collectEvm([ADDR], { ...opts(down.fetchImpl), retries: undefined });
    if (!res.ok) throw new Error(res.gap);
    expect(down.of("ethereum")).toHaveLength(2);
    expect(res.facts[ADDR]!.ethereum!.sent).toBeNull();
  });

  it("денний ліміт не перечікуємо: одна спроба і прогалина", async () => {
    const r = router({ ethereum: () => json({ status: "0", message: "NOTOK", result: "Max daily rate limit reached" }) });
    const res = await collectEvm([ADDR], opts(r.fetchImpl));
    if (!res.ok) throw new Error(res.gap);
    expect(r.of("ethereum")).toHaveLength(1);
    expect(res.facts[ADDR]!.ethereum!.gap).toMatch(/daily/);
  });
});

describe("collectEvm: межа часу", () => {
  it("сторінки зупиняються до межі: лічба як нижня межа, gap stopped early, вік не питаємо", async () => {
    let t = 0;
    const rows = Array.from({ length: 9000 }, (_, i) => row({ ts: 1_700_000_000 - i }));
    const r = router({ ethereum: (p) => { t += 12_000; return paged(rows)(p); } });
    const res = await collectEvm([ADDR], { ...opts(r.fetchImpl), now: () => t, deadline: 45_000 });
    if (!res.ok) throw new Error(res.gap);
    // Старти на 0, 12 і 24 с; о 36 с уже за межею 45 − 10 с.
    expect(r.of("ethereum")).toHaveLength(3);
    expect(res.facts[ADDR]!.ethereum).toMatchObject({ sent: 3000, sentCapped: true, firstTs: null });
    expect(res.facts[ADDR]!.ethereum!.gap).toBe("stopped early: deadline");
  });

  it("запит, що висить, обривається за 2 с до межі; збирач віддає решту мереж", async () => {
    // Сервер не відповідає, доки запит не обірвуть (як справжній fetch із signal).
    const hang = (_p: URLSearchParams, init?: RequestInit) => new Promise<Response>((_, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
    });
    const r = router({ ethereum: hang, base: paged([row({ blockscout: true })]) });
    const t0 = performance.now();
    const res = await collectEvm([ADDR], { ...opts(r.fetchImpl), deadline: Date.now() + 2_400, deadlineMarginMs: 0 });
    expect(performance.now() - t0).toBeLessThan(2_000);
    if (!res.ok) throw new Error(res.gap);
    expect(res.facts[ADDR]!.ethereum).toMatchObject({ sent: null, gap: "stopped early: deadline" });
    expect(res.facts[ADDR]!.base).toMatchObject({ sent: 1 });
  });
});

describe("collectEvm: обміни", () => {
  it("успішні надіслані з назвою-обміном: functionName Etherscan або openchain для решти, одна пачка на всі мережі", async () => {
    const eth = [
      row({ methodId: "0x3593564c", functionName: "execute(bytes commands,bytes[] inputs,uint256 deadline)" }),
      row({ methodId: "0xa9059cbb", functionName: "transfer(address _to, uint256 _value)" }),
      row({ methodId: "0x7ff36ab5", functionName: "swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)", isError: "1" }),
      row({ from: OTHER, methodId: "0x7ff36ab5", functionName: "swapExactETHForTokens(uint256,address[],address,uint256)" }),
      row({ methodId: "0x38ed1739", functionName: "" }),
      row({ methodId: "0x" }),
    ];
    const base = [
      row({ methodId: "0x3593564c", blockscout: true }),
      row({ methodId: "0x095ea7b3", blockscout: true }),
      row({ methodId: "0xdeadbeef", blockscout: true }),
    ];
    const r = router({ ethereum: paged(eth), base: paged(base) });
    const res = await collectEvm([ADDR], opts(r.fetchImpl));
    if (!res.ok) throw new Error(res.gap);
    expect(res.facts[ADDR]!.ethereum).toMatchObject({ sent: 5, swaps: 2 });
    expect(res.facts[ADDR]!.base).toMatchObject({ sent: 3, swaps: 1 });
    const oc = r.of("openchain");
    expect(oc).toHaveLength(1);
    expect(oc[0]!.url.searchParams.get("function")!.split(",").sort()).toEqual(["0x095ea7b3", "0x3593564c", "0x38ed1739", "0xdeadbeef"]);

    // Другий збір: усе з кешу, openchain не питаємо.
    __resetLimiters();
    const r2 = router({ ethereum: paged(eth), base: paged(base) });
    await collectEvm([ADDR], opts(r2.fetchImpl));
    expect(r2.of("openchain")).toHaveLength(0);
  });

  it("openchain не відповів: обміни мережі без назв невідомі (null), а не занижені", async () => {
    const r = router({
      ethereum: paged([row({ methodId: "0x3593564c", functionName: "execute(bytes,bytes[],uint256)" })]),
      base: paged([row({ methodId: "0x3593564c", blockscout: true })]),
      openchain: () => new Response("down", { status: 503 }),
    });
    const res = await collectEvm([ADDR], opts(r.fetchImpl));
    if (!res.ok) throw new Error(res.gap);
    expect(res.facts[ADDR]!.ethereum).toMatchObject({ sent: 1, swaps: 1 });
    expect(res.facts[ADDR]!.ethereum!.gap).toBeUndefined();
    expect(res.facts[ADDR]!.base).toMatchObject({ sent: 1, swaps: null });
    expect(res.facts[ADDR]!.base!.gap).toMatch(/^swaps unknown: openchain/);
  });
});

describe("collectEvm: адреси", () => {
  it("нижній регістр, без повторів; неправильні в partial; лише неправильні = прогалина; порожньо = порожні факти", async () => {
    const r = router({});
    const res = await collectEvm([ADDR, ` ${ADDR.toUpperCase()} `, "0xnope"], opts(r.fetchImpl));
    if (!res.ok) throw new Error(res.gap);
    expect(Object.keys(res.facts)).toEqual([ADDR]);
    expect(res.partial).toEqual({ "0xnope": "not an EVM address" });
    expect(r.of("ethereum")).toHaveLength(1);

    expect(await collectEvm(["0xnope"], opts(r.fetchImpl))).toEqual({ ok: false, gap: "no valid EVM address" });
    expect(await collectEvm([], opts(r.fetchImpl))).toEqual({ ok: true, facts: {} });
  });
});
