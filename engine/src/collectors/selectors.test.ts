import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetLimiters } from "../limits.js";
import { __resetSelectorCaches, isSwapName, resolveSelectors, SELECTOR_BATCH, selectorCachePath } from "./selectors.js";

type Call = { url: URL };
function fakeFetch(route: (c: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetchImpl = (async (u: string | URL | Request) => {
    const c = { url: new URL(String(u)) };
    calls.push(c);
    return route(c);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/** Відповідь openchain за формою справжньої: відомі селектори → [{name, filtered}], невідомі → null. */
const openchain = (known: Record<string, string>) => (c: Call) => {
  const sels = (c.url.searchParams.get("function") ?? "").split(",");
  const fn: Record<string, unknown> = {};
  for (const s of sels) fn[s] = known[s] ? [{ name: known[s], filtered: false, hasVerifiedContract: true }] : null;
  return json({ ok: true, result: { function: fn, event: {} } });
};

let dir: string;
let cachePath: string;
beforeEach(async () => {
  __resetLimiters();
  __resetSelectorCaches();
  dir = await mkdtemp(join(tmpdir(), "ncj-sel-"));
  cachePath = join(dir, "sub", "selectors.json");
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("isSwapName", () => {
  it.each([
    "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
    "swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)",
    "exactInputSingle((address,address,uint24,address,uint256,uint256,uint256,uint160))",
    "exactOutput((bytes,address,uint256,uint256,uint256))",
    "execute(bytes,bytes[],uint256)",
    "execute(bytes,bytes[])",
    "execute(bytes commands,bytes[] inputs,uint256 deadline)",
    "execute(bytes commands, bytes[] inputs)",
    "fillOrder((uint256,uint256),bytes,uint256)",
    "fillQuoteTokenToToken(address,address,address,uint256,uint256,bytes)",
    "sellToUniswap(address[],uint256,uint256,bool)",
    "transformERC20(address,address,uint256,uint256,(uint32,bytes)[])",
    "unoswap(address,uint256,uint256,uint256[])",
    "SWAP(address,uint256)",
  ])("обмін: %s", (n) => expect(isSwapName(n)).toBe(true));

  it.each([
    "swapETH(uint16,address,address,uint256,uint256)",
    "swapETH(uint16 _dstChainId, address _refundAddress, bytes _toAddress, uint256 _amountLD, uint256 _minAmountLD)",
    "execute(bytes32,uint256)",
    "execute(address,uint256,bytes)",
    "transfer(address _to, uint256 _value)",
    "approve(address,uint256)",
    "multicall(bytes[])",
    "",
  ])("не обмін: %s", (n) => expect(isSwapName(n)).toBe(false));

  it("null і undefined не обмін", () => {
    expect(isSwapName(null)).toBe(false);
    expect(isSwapName(undefined)).toBe(false);
  });
});

describe("resolveSelectors", () => {
  it("шлях кешу: SELECTOR_CACHE або ./data/selectors.json", () => {
    expect(selectorCachePath({ SELECTOR_CACHE: "/x/y.json" })).toBe("/x/y.json");
    expect(selectorCachePath({})).toBe("./data/selectors.json");
  });

  it("промах іде в openchain і пишеться у файл; влучання з файлу не йде в мережу", async () => {
    const { fetchImpl, calls } = fakeFetch(openchain({ "0x3593564c": "execute(bytes,bytes[],uint256)", "0xa9059cbb": "transfer(address,uint256)" }));
    const r1 = await resolveSelectors(["0x3593564C", "0xa9059cbb", "0xdeadbeef", "0x", "junk"], { fetchImpl, cachePath });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.origin + calls[0]!.url.pathname).toBe("https://api.openchain.xyz/signature-database/v1/lookup");
    expect(calls[0]!.url.searchParams.get("filter")).toBe("true");
    expect(calls[0]!.url.searchParams.get("function")!.split(",").sort()).toEqual(["0x3593564c", "0xa9059cbb", "0xdeadbeef"]);
    expect(r1.names.get("0x3593564c")).toBe("execute(bytes,bytes[],uint256)");
    expect(r1.names.get("0xdeadbeef")).toBeNull();
    expect(r1.failed.size).toBe(0);

    const onDisk = JSON.parse(await readFile(cachePath, "utf8"));
    expect(onDisk).toEqual({ "0x3593564c": "execute(bytes,bytes[],uint256)", "0xa9059cbb": "transfer(address,uint256)", "0xdeadbeef": null });
    expect((await readdir(join(dir, "sub"))).filter((f) => f.endsWith(".tmp"))).toEqual([]);

    // Новий процес: памʼять порожня, кеш з файлу.
    __resetSelectorCaches();
    const r2 = await resolveSelectors(["0x3593564c", "0xdeadbeef"], { fetchImpl, cachePath });
    expect(calls).toHaveLength(1);
    expect(r2.requests).toBe(0);
    expect(r2.names.get("0x3593564c")).toBe("execute(bytes,bytes[],uint256)");
    expect(r2.names.get("0xdeadbeef")).toBeNull();
  });

  it("пачки не більше 40 селекторів", async () => {
    const { fetchImpl, calls } = fakeFetch(openchain({}));
    const sels = Array.from({ length: 85 }, (_, i) => `0x${i.toString(16).padStart(8, "0")}`);
    const r = await resolveSelectors(sels, { fetchImpl, cachePath });
    expect(calls).toHaveLength(3);
    for (const c of calls) expect(c.url.searchParams.get("function")!.split(",").length).toBeLessThanOrEqual(SELECTOR_BATCH);
    expect(r.names.size).toBe(85);
  });

  it("openchain не відповів: селектори в failed, у кеш не пишуться, наступного разу питаємо знову", async () => {
    let down = true;
    const { fetchImpl, calls } = fakeFetch((c) => down ? new Response("oops", { status: 503 }) : openchain({ "0x12345678": "swap(uint256)" })(c));
    const r1 = await resolveSelectors(["0x12345678"], { fetchImpl, cachePath, retries: 0, retryDelayMs: 0 });
    expect([...r1.failed]).toEqual(["0x12345678"]);
    expect(r1.names.has("0x12345678")).toBe(false);
    expect(r1.error).toMatch(/openchain/);
    down = false;
    const r2 = await resolveSelectors(["0x12345678"], { fetchImpl, cachePath, retries: 0, retryDelayMs: 0 });
    expect(calls).toHaveLength(2);
    expect(r2.names.get("0x12345678")).toBe("swap(uint256)");
  });

  it("ok: false від openchain теж збій, а не «назви немає»", async () => {
    const { fetchImpl } = fakeFetch(() => json({ ok: false, error: "bad" }));
    const r = await resolveSelectors(["0x12345678"], { fetchImpl, cachePath, retries: 0 });
    expect(r.failed.has("0x12345678")).toBe(true);
  });

  it("зіпсований файл кешу: починаємо з порожнього", async () => {
    await mkdir(join(dir, "sub"), { recursive: true });
    await writeFile(cachePath, "{not json", "utf8");
    const { fetchImpl, calls } = fakeFetch(openchain({ "0xa9059cbb": "transfer(address,uint256)" }));
    const r = await resolveSelectors(["0xa9059cbb"], { fetchImpl, cachePath });
    expect(calls).toHaveLength(1);
    expect(r.names.get("0xa9059cbb")).toBe("transfer(address,uint256)");
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({ "0xa9059cbb": "transfer(address,uint256)" });
  });

  it("запис зливає з тим, що інший процес уже дописав у файл", async () => {
    const { fetchImpl } = fakeFetch(openchain({ "0x11111111": "a()", "0x22222222": "b()" }));
    await resolveSelectors(["0x11111111"], { fetchImpl, cachePath });
    // Інший процес дописав свій селектор.
    const disk = JSON.parse(await readFile(cachePath, "utf8"));
    await writeFile(cachePath, JSON.stringify({ ...disk, "0x33333333": "c()" }), "utf8");
    await resolveSelectors(["0x22222222"], { fetchImpl, cachePath });
    expect(JSON.parse(await readFile(cachePath, "utf8"))).toEqual({ "0x11111111": "a()", "0x22222222": "b()", "0x33333333": "c()" });
  });
});
