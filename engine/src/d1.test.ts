// Перенесено з NextRole (написано до запуску 14.09.2026).
import { describe, expect, it, vi } from "vitest";
import { D1Client, D1HttpError, D1ThrottledError } from "./d1.js";

const creds = { accountId: "a", databaseId: "d", token: "t" };
const okBody = JSON.stringify({ success: true, result: [{ success: true, results: [{ n: 1 }] }], errors: [] });
const client = (fetchImpl: unknown, attempts = 3) =>
  new D1Client(creds, { fetchImpl: fetchImpl as typeof fetch, attempts, retryDelayMs: 0 });

describe("D1Client.post — повтори", () => {
  it("мережевий збій — повтор, і друга спроба рятує", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const f = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("fetch failed"), { cause: new Error("ECONNRESET") }))
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }));
    await expect(client(f).query("SELECT 1")).resolves.toEqual([{ n: 1 }]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("5xx — повтор до трьох разів, потім помилка", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const f = vi.fn().mockImplementation(async () => new Response("bad gateway", { status: 502 }));
    await expect(client(f).execute("SELECT 1")).rejects.toThrow(/502/);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("4xx і помилка SQL — без повторів", async () => {
    const f = vi.fn().mockResolvedValue(new Response("nope", { status: 400 }));
    await expect(client(f).execute("SELECT 1")).rejects.toBeInstanceOf(D1HttpError);
    expect(f).toHaveBeenCalledTimes(1);

    const g = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: false, result: [], errors: [{ code: 1, message: "no such table" }] }), { status: 200 }));
    await expect(client(g).execute("SELECT 1")).rejects.toThrow(/no such table/);
    expect(g).toHaveBeenCalledTimes(1);
  });

  /**
   * 429 — той самий випадок, що звалив розсилку 03.09.
   *
   * Він 4xx за формою, але за змістом це прохання зачекати, тож ділить
   * гілку з 5xx, а не з «винні ми».
   */
  it("429 — повтор, і друга спроба рятує", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const throttled = JSON.stringify({ messages: [], result: null, success: false,
      errors: [{ code: 7429, message: "Your account is generating too much load on D1 DBs." }] });
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(throttled, { status: 429 }))
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }));
    await expect(client(f).query("SELECT 1")).resolves.toEqual([{ n: 1 }]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("429 без просвітку — три спроби, і лише тоді помилка", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const f = vi.fn().mockImplementation(async () => new Response("too much load", { status: 429 }));
    await expect(client(f).execute("SELECT 1")).rejects.toBeInstanceOf(D1ThrottledError);
    expect(f).toHaveBeenCalledTimes(3);
  });

  /**
   * Пауза на 429 мусить бути ДОВША за паузу на 5xx: нас просять зняти
   * навантаження, а не перепитати швидше.
   */
  it("429 чекає довше за 5xx", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const waits: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      waits.push(ms ?? 0); fn(); return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
    try {
      const mk = (status: number) => new D1Client(creds, {
        fetchImpl: (async () => new Response("nope", { status })) as unknown as typeof fetch,
        attempts: 2, retryDelayMs: 1_000 });
      await expect(mk(502).execute("SELECT 1")).rejects.toThrow();
      const slow = waits.length;
      await expect(mk(429).execute("SELECT 1")).rejects.toThrow();
      expect(waits[slow]!).toBeGreaterThan(waits[slow - 1]!);
    } finally {
      vi.mocked(globalThis.setTimeout).mockRestore();
    }
  });

  it("429 з Retry-After слухається сервера", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const waits: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      waits.push(ms ?? 0); fn(); return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
    try {
      const f = vi.fn()
        .mockResolvedValueOnce(new Response("wait", { status: 429, headers: { "retry-after": "7" } }))
        .mockResolvedValueOnce(new Response(okBody, { status: 200 }));
      const c = new D1Client(creds, { fetchImpl: f as typeof fetch, attempts: 2, retryDelayMs: 1_000 });
      await expect(c.query("SELECT 1")).resolves.toEqual([{ n: 1 }]);
      expect(waits).toEqual([7_000]);
    } finally {
      vi.mocked(globalThis.setTimeout).mockRestore();
    }
  });

  it("401 — без повторів і з поясненням про токен", async () => {
    const f = vi.fn().mockResolvedValue(new Response("unauthorized", { status: 401 }));
    await expect(client(f).execute("SELECT 1")).rejects.toThrow(/CF_API_TOKEN/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("кожен запит іде з таймаутом", async () => {
    const f = vi.fn().mockResolvedValue(new Response(okBody, { status: 200 }));
    await client(f).query("SELECT 1");
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});
