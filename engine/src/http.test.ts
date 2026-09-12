// Перенесено з NextRole (написано до запуску 14.09.2026).
import { describe, expect, it } from "vitest";
import { runSource, SourceUnavailableError } from "./http.js";

describe("runSource", () => {
  it("429 позначає rateLimited, а не broken", async () => {
    const out = await runSource("aggregator:x", async () => { throw new SourceUnavailableError("x → 429", 429); });
    expect(out.ok).toBe(false);
    expect(out.rateLimited).toBe(true);
    expect(out.broken).toBe(false);
  });
  it("404 лишається broken", async () => {
    const out = await runSource("aggregator:x", async () => { throw new SourceUnavailableError("x → 404", 404); });
    expect(out.broken).toBe(true);
    expect(out.rateLimited).toBe(false);
  });
});

import { checkUrlShape, isPrivateIp, safeFetch, fetchJson, UnsafeUrlError, MAX_BODY_BYTES } from "./http.js";

describe("політика адрес", () => {
  it.each(["127.0.0.1", "10.1.2.3", "169.254.169.254", "172.16.0.1", "192.168.1.1", "0.0.0.0", "::1", "fd00::1", "::ffff:127.0.0.1", "100.64.0.1"])
    ("%s — приватна", (ip) => expect(isPrivateIp(ip)).toBe(true));
  it.each(["8.8.8.8", "104.16.1.1", "2606:4700::1111"])("%s — публічна", (ip) => expect(isPrivateIp(ip)).toBe(false));

  it.each([
    "ftp://jobs.dou.ua/feed", "file:///etc/passwd", "javascript:alert(1)",
    "http://localhost:8080/x", "http://127.0.0.1/x", "http://[::1]/x", "http://169.254.169.254/latest/meta-data/",
    "https://user:pw@jobs.dou.ua/x", "http://intranet/x", "http://scanner.internal/x",
  ])("%s — відкидається без мережі", (u) => {
    expect(() => checkUrlShape(u)).toThrow(UnsafeUrlError);
  });
  it("звичайна https-адреса проходить", () => {
    expect(checkUrlShape("https://jobs.dou.ua/vacancies/feeds/?category=Python").hostname).toBe("jobs.dou.ua");
  });
});

describe("safeFetch: редиректи", () => {
  const redirectTo = (loc: string) => new Response(null, { status: 302, headers: { location: loc } });
  const ok = () => new Response("[]", { status: 200 });

  it("редирект на приватний хост не виконується", async () => {
    const calls: string[] = [];
    const fetchImpl = (async (u: string | URL | Request) => {
      calls.push(String(u));
      return calls.length === 1 ? redirectTo("http://127.0.0.1:9200/_cat/indices") : ok();
    }) as unknown as typeof fetch;
    await expect(safeFetch("https://feed.example.com/rss", {}, { fetchImpl })).rejects.toThrow(UnsafeUrlError);
    expect(calls).toEqual(["https://feed.example.com/rss"]);
  });

  it("публічне ім'я, що резолвиться в приватну мережу, не виконується", async () => {
    const fetchImpl = (async () => ok()) as unknown as typeof fetch;
    const lookup = async () => ["10.0.0.5"];
    await expect(safeFetch("https://feed.example.com/rss", {}, { fetchImpl, lookup })).rejects.toThrow(/приватну/);
  });

  it("публічний редирект виконується, але не більше трьох стрибків", async () => {
    let n = 0;
    const fetchImpl = (async () => (n++ < 3 ? redirectTo("https://cdn.example.com/rss") : ok())) as unknown as typeof fetch;
    const res = await safeFetch("https://feed.example.com/rss", {}, { fetchImpl });
    expect(res.status).toBe(200);
    n = 0;
    const loop = (async () => redirectTo("https://feed.example.com/rss")) as unknown as typeof fetch;
    await expect(safeFetch("https://feed.example.com/rss", {}, { fetchImpl: loop })).rejects.toThrow(/редирект/);
  });

  it("небезпечна адреса стає broken-джерелом, не повтором", async () => {
    const fetchImpl = (async () => ok()) as unknown as typeof fetch;
    await expect(fetchJson("http://169.254.169.254/latest", {}, { fetchImpl, retries: 0 }))
      .rejects.toMatchObject({ name: "SourceUnavailableError", status: 403 });
  });
});

describe("стеля на тіло відповіді", () => {
  it("тіло понад стелю обриває джерело замість пам'яті", async () => {
    const big = new Uint8Array(64 * 1024).fill(0x5b);   // «[[[[…»
    const stream = new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(big); },   // нескінченно
    });
    const fetchImpl = (async () => new Response(stream, { status: 200 })) as unknown as typeof fetch;
    await expect(fetchJson("https://feed.example.com/rss", {}, { fetchImpl, retries: 0, maxBodyBytes: 256 * 1024 }))
      .rejects.toThrow(/МБ/);
    expect(MAX_BODY_BYTES).toBeGreaterThan(1024 * 1024);
  });
});
