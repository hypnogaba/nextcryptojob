// Перенесено з NextRole.
import type { LookupAddress } from "node:dns";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkUrlShape, fetchJson, guardedLookup, isPrivateIp, redact, safeFetch, SourceUnavailableError, UnsafeUrlError } from "./http.js";
import { __resetLimiters } from "./limits.js";

type Impl = (url: string, init: RequestInit) => Response | Promise<Response>;
const asFetch = (impl: Impl) => (async (u: string | URL | Request, init?: RequestInit) => impl(String(u), init ?? {})) as unknown as typeof fetch;
const headersOf = (init: RequestInit) => new Headers(init.headers);

beforeEach(() => { __resetLimiters(); });
afterEach(() => { vi.useRealTimers(); });

describe("політика адрес", () => {
  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.0.1", "192.168.1.1", "0.0.0.0", "::1", "fd00::1", "::ffff:127.0.0.1", "100.64.0.1"])
    ("%s: приватна", (ip) => expect(isPrivateIp(ip)).toBe(true));
  it.each(["8.8.8.8", "104.16.1.1", "2606:4700::1111", "2001:4860:4860::8888", "64:ff9c::1"])("%s: публічна", (ip) => expect(isPrivateIp(ip)).toBe(false));
  it.each(["64:ff9b::10.0.0.1", "64:ff9b::a00:1", "64:ff9b::808:808", "64:ff9b:0:0:0:0:7f00:1", "64:ff9b:1::1",
    "2002::1", "2002:c0a8:101::1", "2002:0808:0808::1"])("%s: NAT64 і 6to4 блокуються (обгортки IPv4)", (ip) => expect(isPrivateIp(ip)).toBe(true));
  it("URL з NAT64-літералом відкидається без мережі", () => {
    expect(() => checkUrlShape("https://[64:ff9b::7f00:1]/")).toThrow(UnsafeUrlError);
    expect(() => checkUrlShape("https://[2002:7f00:1::]/")).toThrow(UnsafeUrlError);
  });

  it.each([
    "ftp://jobs.dou.ua/feed", "file:///etc/passwd", "javascript:alert(1)",
    "http://localhost:8080/x", "http://127.0.0.1/x", "http://[::1]/x", "http://169.254.169.254/latest/meta-data/",
    "https://user:pw@jobs.dou.ua/x", "http://intranet/x", "http://scanner.internal/x",
  ])("%s: відкидається без мережі", (u) => {
    expect(() => checkUrlShape(u)).toThrow(UnsafeUrlError);
  });
  it("звичайна https-адреса проходить", () => {
    expect(checkUrlShape("https://jobs.dou.ua/vacancies/feeds/?category=Python").hostname).toBe("jobs.dou.ua");
  });
});

describe("redact: ключі не потрапляють у тексти помилок", () => {
  it("маскує значення ключових параметрів і лишає решту", () => {
    const out = redact("https://api.etherscan.io/v2/api?module=account&apikey=SECRET1&address=0xabc&api-key=SECRET2&access_token=SECRET3&client_secret=SECRET4#frag");
    expect(out).not.toMatch(/SECRET/);
    expect(out).toContain("https://api.etherscan.io/v2/api");
    expect(out).toContain("module=account");
    expect(out).toContain("address=0xabc");
    expect(out).not.toContain("frag");
  });

  it("незрозумілий рядок віддає без запиту", () => {
    expect(redact("not a url?token=SECRET")).not.toMatch(/SECRET/);
  });

  const SECRET = "SECRET-7f3a";
  const url = `https://api.example.com/v1/data?apikey=${SECRET}&q=ok`;
  const scenarios: Record<string, Impl> = {
    "404": () => new Response("no", { status: 404 }),
    "500 після повторів": () => new Response("no", { status: 500 }),
    "429 після повторів": () => new Response("slow", { status: 429 }),
    "не JSON": () => new Response("<xml/>", { status: 200 }),
    "мережевий збій з адресою в тексті": () => { throw new TypeError(`fetch failed: ${url}`); },
    "сторінка-заглушка": () => new Response("<title>Just a moment</title>", { headers: { "content-type": "text/html" } }),
    "забагато редиректів": () => new Response(null, { status: 302, headers: { location: url } }),
    "завелике тіло": () => new Response("[1,2,3,4,5,6,7,8,9,10,11,12]", { status: 200 }),
  };
  it.each(Object.keys(scenarios))("помилка «%s» не містить ключа", async (name) => {
    const fetchImpl = asFetch(scenarios[name]!);
    const err = await fetchJson(url, {}, { fetchImpl, retries: 1, retryDelayMs: 0, backoffOn429Ms: 0, maxBodyBytes: 16 })
      .then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).not.toContain(SECRET);
    expect((err as Error).message).toContain("api.example.com");
  });
});

describe("safeFetch: редиректи", () => {
  const redirectTo = (loc: string, status = 302) => new Response(null, { status, headers: { location: loc } });
  const ok = () => new Response("[]", { status: 200 });

  it("редирект на приватний хост не виконується", async () => {
    const calls: string[] = [];
    const fetchImpl = asFetch((u) => {
      calls.push(u);
      return calls.length === 1 ? redirectTo("http://127.0.0.1:9200/_cat/indices") : ok();
    });
    await expect(safeFetch("https://feed.example.com/rss", {}, { fetchImpl })).rejects.toThrow(UnsafeUrlError);
    expect(calls).toEqual(["https://feed.example.com/rss"]);
  });

  it("публічне ім'я, що резолвиться в приватну мережу, не виконується", async () => {
    const fetchImpl = asFetch(() => ok());
    const lookup = async () => ["10.0.0.5"];
    await expect(safeFetch("https://feed.example.com/rss", {}, { fetchImpl, lookup })).rejects.toThrow(/приватну/);
  });

  it("публічний редирект виконується, але не більше трьох стрибків", async () => {
    let n = 0;
    const fetchImpl = asFetch(() => (n++ < 3 ? redirectTo("https://cdn.example.com/rss") : ok()));
    const res = await safeFetch("https://feed.example.com/rss", {}, { fetchImpl });
    expect(res.status).toBe(200);
    const loop = asFetch(() => redirectTo("https://feed.example.com/rss"));
    await expect(safeFetch("https://feed.example.com/rss", {}, { fetchImpl: loop })).rejects.toThrow(/редирект/);
  });

  it("небезпечна адреса стає broken-джерелом, не повтором", async () => {
    const fetchImpl = asFetch(() => ok());
    await expect(fetchJson("http://169.254.169.254/latest", {}, { fetchImpl, retries: 0 }))
      .rejects.toMatchObject({ name: "SourceUnavailableError", status: 403 });
  });

  it("на чужий origin облікові заголовки не їдуть, решта лишається", async () => {
    const seen: Headers[] = [];
    const fetchImpl = asFetch((_u, init) => {
      seen.push(headersOf(init));
      return seen.length === 1 ? redirectTo("https://cdn.other.net/data") : ok();
    });
    await safeFetch("https://api.example.com/data", {
      headers: {
        Authorization: "Bearer a", Cookie: "s=1", "Proxy-Authorization": "Basic b",
        "X-Api-Key": "k", "X-Auth-Token": "t", Accept: "application/json",
      },
    }, { fetchImpl });
    const second = seen[1]!;
    for (const h of ["authorization", "cookie", "proxy-authorization", "x-api-key", "x-auth-token"]) {
      expect(second.has(h), h).toBe(false);
    }
    expect(second.get("accept")).toBe("application/json");
  });

  it("у межах того самого origin облікові заголовки зберігаються", async () => {
    const seen: Headers[] = [];
    const fetchImpl = asFetch((_u, init) => {
      seen.push(headersOf(init));
      return seen.length === 1 ? redirectTo("/v2/data") : ok();
    });
    await safeFetch("https://api.example.com/v1/data", { headers: { Authorization: "Bearer a" } }, { fetchImpl });
    expect(seen[1]!.get("authorization")).toBe("Bearer a");
  });

  it("POST на 307 у межах origin зберігає метод і тіло", async () => {
    const seen: RequestInit[] = [];
    const fetchImpl = asFetch((_u, init) => {
      seen.push(init);
      return seen.length === 1 ? redirectTo("/rpc2", 307) : ok();
    });
    await safeFetch("https://rpc.example.com/rpc", { method: "POST", body: '{"id":1}' }, { fetchImpl });
    expect(seen[1]!.method).toBe("POST");
    expect(seen[1]!.body).toBe('{"id":1}');
  });

  it.each([
    ["302 у межах origin", "/rpc2", 302],
    ["303 у межах origin", "/rpc2", 303],
    ["307 на чужий origin", "https://other.example.net/rpc", 307],
    ["308 на чужий origin", "https://other.example.net/rpc", 308],
  ] as const)("POST на %s не перетворюється мовчки на GET, а відмовляє", async (_name, loc, status) => {
    const calls: string[] = [];
    const fetchImpl = asFetch((u) => { calls.push(u); return calls.length === 1 ? redirectTo(loc, status) : ok(); });
    await expect(safeFetch("https://rpc.example.com/rpc", { method: "POST", body: "{}" }, { fetchImpl }))
      .rejects.toThrow(/POST/);
    expect(calls).toHaveLength(1);
  });
});

describe("SSRF: з'єднання лише на перевірену IP (DNS rebinding)", () => {
  type Cb = (err: Error | null, address: string | LookupAddress[], family?: number) => void;
  const run = (lookup: ReturnType<typeof guardedLookup>, all: boolean, family?: number) =>
    new Promise<{ err: Error | null; address: string | LookupAddress[]; family?: number }>((resolve) => {
      (lookup as unknown as (h: string, o: object, cb: Cb) => void)(
        "site.example.com", { all, ...(family ? { family } : {}) },
        (err, address, fam) => resolve({ err, address, family: fam }));
    });

  it("публічні адреси проходять у форматі, якого чекає net.connect", async () => {
    const lookup = guardedLookup(async () => ["93.184.216.34", "2606:2800:220:1::1"]);
    expect((await run(lookup, true)).address).toEqual([
      { address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1::1", family: 6 },
    ]);
    expect(await run(lookup, false)).toMatchObject({ err: null, address: "93.184.216.34", family: 4 });
    expect(await run(lookup, false, 6)).toMatchObject({ err: null, address: "2606:2800:220:1::1", family: 6 });
  });

  it.each([["лише приватна", ["10.0.0.5"]], ["публічна разом із приватною", ["93.184.216.34", "127.0.0.1"]],
    ["IPv6 loopback", ["::1"]], ["metadata", ["169.254.169.254"]]])("%s: відмова", async (_n, addrs) => {
    const { err } = await run(guardedLookup(async () => addrs), true);
    expect(err).toBeInstanceOf(UnsafeUrlError);
  });

  it("порожній DNS: джерело недоступне, а не небезпечне", async () => {
    const { err } = await run(guardedLookup(async () => []), true);
    expect(err).toBeInstanceOf(SourceUnavailableError);
  });

  it("ім'я, що після перевірки почало вказувати на 127.0.0.1, не отримує запиту", async () => {
    let hits = 0;
    const server = createServer((_q, r) => { hits++; r.end("{}"); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const answers = [["93.184.216.34"], ["127.0.0.1"]];
      const lookup = async () => answers.shift() ?? ["127.0.0.1"];
      await expect(safeFetch(`http://rebind.example.test:${port}/`, {}, { lookup })).rejects.toThrow(UnsafeUrlError);
      expect(answers).toHaveLength(0);   // друге питання поставило саме з'єднання
      expect(hits).toBe(0);
      await expect(fetchJson(`http://rebind2.example.test:${port}/`, {}, { lookup: async () => ["127.0.0.1"], retries: 2 }))
        .rejects.toMatchObject({ name: "SourceUnavailableError", status: 403 });
      expect(hits).toBe(0);
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe("заголовки й тіло відповіді", () => {
  it("заголовки викликача зливаються з типовими через Headers і мають перевагу", async () => {
    let seen: Headers | undefined;
    const fetchImpl = asFetch((_u, init) => { seen = headersOf(init); return new Response("{}"); });
    await fetchJson("https://api.example.com/x", { headers: new Headers({ Authorization: "Bearer z", Accept: "application/vnd.x+json" }) }, { fetchImpl });
    expect(seen!.get("authorization")).toBe("Bearer z");
    expect(seen!.get("accept")).toBe("application/vnd.x+json");
    expect(seen!.get("user-agent")).toBe("NextCryptoJobBot/0.1 (+https://nextcryptojob.xyz)");
  });

  it("JSON зі словами «just a moment» повертається як є", async () => {
    const body = JSON.stringify({ text: "Just a moment, we are thinking" });
    const fetchImpl = asFetch(() => new Response(body, { headers: { "content-type": "application/json" } }));
    await expect(fetchJson("https://api.example.com/x", {}, { fetchImpl })).resolves.toEqual({ text: "Just a moment, we are thinking" });
  });

  it("HTML-заглушка захисту стає недоступним джерелом", async () => {
    const fetchImpl = asFetch(() => new Response("<html><title>Just a moment...</title></html>", { headers: { "content-type": "text/html; charset=utf-8" } }));
    await expect(fetchJson("https://api.example.com/x", {}, { fetchImpl, retries: 0 })).rejects.toThrow(/заглушк/);
  });

  it("тіло понад стелю обриває джерело замість пам'яті", async () => {
    const big = new Uint8Array(64 * 1024).fill(0x5b);   // «[[[[…»
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(big); },   // нескінченно
    });
    const fetchImpl = asFetch(() => new Response(stream, { status: 200 }));
    await expect(fetchJson("https://feed.example.com/rss", {}, { fetchImpl, retries: 0, maxBodyBytes: 256 * 1024 }))
      .rejects.toThrow(/МБ/);
  });
});

describe("safeFetch і бюджети запитів", () => {
  beforeEach(() => { vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] }); });

  const settle = async <T>(p: Promise<T>): Promise<T> => { p.catch(() => undefined); await vi.runAllTimersAsync(); return p; };

  it("кожен стрибок редиректу бере слот бюджету свого хоста", async () => {
    const starts: Array<[string, number]> = [];
    const t0 = Date.now();
    const fetchImpl = asFetch((u) => {
      starts.push([new URL(u).pathname, Date.now() - t0]);
      return u.endsWith("/a") ? new Response(null, { status: 302, headers: { location: "/b" } }) : new Response("{}");
    });
    await settle(Promise.all([
      fetchJson("https://api.etherscan.io/a", {}, { fetchImpl }),
      fetchJson("https://api.etherscan.io/a", {}, { fetchImpl }),
    ]));
    expect(starts.map(([, t]) => t)).toEqual([0, 250, 500, 750]);
  });

  it("кожна повторна спроба теж проходить через бюджет", async () => {
    const starts: number[] = [];
    const t0 = Date.now();
    const fetchImpl = asFetch(() => { starts.push(Date.now() - t0); return new Response("x", { status: 502 }); });
    await expect(settle(fetchJson("https://api.etherscan.io/x", {}, { fetchImpl, retries: 2, retryDelayMs: 0 })))
      .rejects.toBeInstanceOf(SourceUnavailableError);
    expect(starts).toEqual([0, 250, 500]);
  });

  it("429 з Retry-After зупиняє весь бюджет, а не лише цей виклик", async () => {
    const starts: Array<[string, number]> = [];
    const t0 = Date.now();
    let first = true;
    const fetchImpl = asFetch((u) => {
      starts.push([new URL(u).pathname, Date.now() - t0]);
      if (first) { first = false; return new Response("slow", { status: 429, headers: { "retry-after": "2" } }); }
      return new Response("{}");
    });
    const a = fetchJson("https://api.example.com/a", {}, { fetchImpl, retryDelayMs: 0 });
    await vi.advanceTimersByTimeAsync(10);
    const b = fetchJson("https://api.example.com/b", {}, { fetchImpl });
    await settle(Promise.all([a, b]));
    expect(starts).toEqual([["/a", 0], ["/a", 2_000], ["/b", 2_000]]);
  });

  it("Retry-After понад хвилину обрізається до хвилини", async () => {
    const starts: number[] = [];
    const t0 = Date.now();
    const fetchImpl = asFetch(() => {
      starts.push(Date.now() - t0);
      return starts.length === 1 ? new Response("slow", { status: 429, headers: { "retry-after": "3600" } }) : new Response("{}");
    });
    await settle(fetchJson("https://api.example.com/a", {}, { fetchImpl, retryDelayMs: 0 }));
    expect(starts).toEqual([0, 60_000]);
  });

  it("maxBackoffMs обрізає Retry-After для всього бюджету", async () => {
    const starts: number[] = [];
    const t0 = Date.now();
    const fetchImpl = asFetch(() => {
      starts.push(Date.now() - t0);
      return starts.length === 1 ? new Response("slow", { status: 429, headers: { "retry-after": "3600" } }) : new Response("{}");
    });
    await settle(fetchJson("https://api.example.com/a", {}, { fetchImpl, retryDelayMs: 0, maxBackoffMs: 15_000 }));
    expect(starts).toEqual([0, 15_000]);
  });

  it("429 без Retry-After чекає зростаючу паузу", async () => {
    const starts: number[] = [];
    const t0 = Date.now();
    const fetchImpl = asFetch(() => {
      starts.push(Date.now() - t0);
      return starts.length < 3 ? new Response("slow", { status: 429 }) : new Response("{}");
    });
    await settle(fetchJson("https://api.example.com/a", {}, { fetchImpl, retries: 2, retryDelayMs: 100 }));
    expect(starts).toEqual([0, 200, 600]);
  });

  it("скасований сигнал знімає запит із черги бюджету, і повтору немає", async () => {
    const calls: string[] = [];
    const fetchImpl = asFetch(async (u) => {
      calls.push(new URL(u).pathname);
      await new Promise((r) => setTimeout(r, 1_000));
      return new Response("{}");
    });
    const busy = fetchJson("https://api.etherscan.io/busy", {}, { fetchImpl });
    const ac = new AbortController();
    const queued = fetchJson("https://api.etherscan.io/queued", { signal: ac.signal }, { fetchImpl });
    await vi.advanceTimersByTimeAsync(10);
    ac.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    await settle(busy);
    expect(calls).toEqual(["/busy"]);
  });

  it("сигнал доходить до fetch", async () => {
    let got: AbortSignal | null | undefined;
    const fetchImpl = asFetch((_u, init) => { got = init.signal; return new Response("{}"); });
    const ac = new AbortController();
    await settle(safeFetch("https://api.example.com/x", { signal: ac.signal }, { fetchImpl }));
    expect(got).toBeInstanceOf(AbortSignal);
    ac.abort();
    expect(got!.aborted).toBe(true);
  });
});
