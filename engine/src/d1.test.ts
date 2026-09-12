// Перенесено з NextRole (написано до запуску 14.09.2026).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { D1Client, D1HttpError, D1ThrottledError } from "./d1.js";
import { __resetLimiters } from "./limits.js";

const creds = { accountId: "a", databaseId: "d", token: "t" };
const envelope = (results: unknown[] = [{ n: 1 }], meta: unknown = { changes: 0 }) =>
  JSON.stringify({ success: true, result: [{ success: true, results, meta }], errors: [] });
const okBody = envelope();
const client = (fetchImpl: unknown, attempts = 3) =>
  new D1Client(creds, { fetchImpl: fetchImpl as typeof fetch, attempts, retryDelayMs: 0 });
const netError = () => Object.assign(new Error("fetch failed"), { cause: new Error("ECONNRESET") });

/** Запускає проміс до кінця під фейковими таймерами, не лишаючи необробленої відмови. */
const settle = async <T>(p: Promise<T>): Promise<T> => { p.catch(() => undefined); await vi.runAllTimersAsync(); return p; };

/** fetch, що записує, коли його викликали (мс від старту тесту). */
const timed = (responses: Array<() => Response | Promise<Response>>) => {
  const t0 = Date.now();
  const at: number[] = [];
  const f = vi.fn(async () => { at.push(Date.now() - t0); return (responses[Math.min(at.length - 1, responses.length - 1)]!)(); });
  return { f: f as unknown as typeof fetch, at };
};

beforeEach(() => {
  __resetLimiters();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe("D1Client: повтори", () => {
  it("мережевий збій на читанні: повтор, і друга спроба рятує", async () => {
    const f = vi.fn()
      .mockRejectedValueOnce(netError())
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }));
    await expect(settle(client(f).query("SELECT 1"))).resolves.toEqual([{ n: 1 }]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("5xx на читанні: повтор до трьох разів, потім помилка", async () => {
    const f = vi.fn().mockImplementation(async () => new Response("bad gateway", { status: 502 }));
    await expect(settle(client(f).execute("SELECT 1"))).rejects.toThrow(/502/);
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("4xx і помилка SQL: без повторів", async () => {
    const f = vi.fn().mockResolvedValue(new Response("nope", { status: 400 }));
    await expect(settle(client(f).execute("SELECT 1"))).rejects.toBeInstanceOf(D1HttpError);
    expect(f).toHaveBeenCalledTimes(1);

    const g = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ success: false, result: [], errors: [{ code: 1, message: "no such table" }] }), { status: 200 }));
    await expect(settle(client(g).execute("SELECT 1"))).rejects.toThrow(/no such table/);
    expect(g).toHaveBeenCalledTimes(1);
  });

  /**
   * 429 той самий випадок, що звалив розсилку NextRole 03.09.
   * Він 4xx за формою, але за змістом це прохання зачекати.
   */
  it("429: повтор, і друга спроба рятує", async () => {
    const throttled = JSON.stringify({ messages: [], result: null, success: false,
      errors: [{ code: 7429, message: "Your account is generating too much load on D1 DBs." }] });
    const f = vi.fn()
      .mockResolvedValueOnce(new Response(throttled, { status: 429 }))
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }));
    await expect(settle(client(f).query("SELECT 1"))).resolves.toEqual([{ n: 1 }]);
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("429 без просвітку: три спроби, і лише тоді помилка", async () => {
    const f = vi.fn().mockImplementation(async () => new Response("too much load", { status: 429 }));
    await expect(settle(client(f).execute("SELECT 1"))).rejects.toBeInstanceOf(D1ThrottledError);
    expect(f).toHaveBeenCalledTimes(3);
  });

  /** Пауза на 429 мусить бути ДОВША за паузу на 5xx: нас просять зняти навантаження. */
  it("429 чекає довше за 5xx", async () => {
    const mk = (status: number) => {
      const t = timed([() => new Response("nope", { status })]);
      return { t, c: new D1Client(creds, { fetchImpl: t.f, attempts: 2, retryDelayMs: 1_000 }) };
    };
    const fiveXX = mk(502);
    await expect(settle(fiveXX.c.execute("SELECT 1"))).rejects.toThrow();
    __resetLimiters();
    const throttled = mk(429);
    await expect(settle(throttled.c.execute("SELECT 1"))).rejects.toThrow();
    const gap = (at: number[]) => at[1]! - at[0]!;
    expect(gap(fiveXX.t.at)).toBe(1_000);
    expect(gap(throttled.t.at)).toBeGreaterThan(gap(fiveXX.t.at));
  });

  it("429 з Retry-After слухається сервера", async () => {
    const t = timed([
      () => new Response("wait", { status: 429, headers: { "retry-after": "7" } }),
      () => new Response(okBody, { status: 200 }),
    ]);
    const c = new D1Client(creds, { fetchImpl: t.f, attempts: 2, retryDelayMs: 1_000 });
    await expect(settle(c.query("SELECT 1"))).resolves.toEqual([{ n: 1 }]);
    expect(t.at).toEqual([0, 7_000]);
  });

  it.each([401, 403])("%i: без повторів і з переліком можливих причин", async (status) => {
    const f = vi.fn().mockResolvedValue(new Response("unauthorized", { status }));
    const err = await settle(client(f).execute("SELECT 1")).then(() => null, (e: Error) => e);
    expect(f).toHaveBeenCalledTimes(1);
    expect(err!.message).toMatch(/CF_API_TOKEN/);
    expect(err!.message).toMatch(/CF_ACCOUNT_ID/);
    expect(err!.message).toMatch(/CF_D1_DATABASE_ID/);
    expect(err!.message).toMatch(/nextcryptojob/);
    expect(err!.message).not.toContain("\u2014");   // довге тире
  });

  it("кожен запит іде з таймаутом", async () => {
    const f = vi.fn().mockResolvedValue(new Response(okBody, { status: 200 }));
    await settle(client(f).query("SELECT 1"));
    const init = f.mock.calls[0]![1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("D1Client: інструкції, що змінюють дані", () => {
  const CLAIM = "UPDATE score_jobs SET status='running', attempts=attempts+1 WHERE id=? AND status='queued'";

  it("run повертає changes із meta", async () => {
    const f = vi.fn().mockResolvedValue(new Response(envelope([], { changes: 1, last_row_id: 0 }), { status: 200 }));
    await expect(settle(client(f).run(CLAIM, [7]))).resolves.toEqual({ changes: 1 });
    const body = JSON.parse((f.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ sql: CLAIM, params: [7] });
  });

  it("run без meta.changes відмовляє, а не вигадує нуль", async () => {
    const f = vi.fn().mockResolvedValue(new Response(envelope([], {}), { status: 200 }));
    await expect(settle(client(f).run(CLAIM, [7]))).rejects.toThrow(/changes/);
  });

  it.each([
    ["мережевий збій", () => Promise.reject(netError())],
    ["таймаут", () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError"))],
    ["502", () => Promise.resolve(new Response("bad gateway", { status: 502 }))],
  ] as const)("%s після неідемпотентного UPDATE: без повтору, бо він міг уже виконатись", async (_name, fail) => {
    const f = vi.fn().mockImplementationOnce(fail).mockResolvedValue(new Response(envelope([], { changes: 1 }), { status: 200 }));
    await expect(settle(client(f).run(CLAIM, [7]))).rejects.toThrow();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("429 на неідемпотентному UPDATE повторюється: сервер його не виконував", async () => {
    const f = vi.fn()
      .mockResolvedValueOnce(new Response("too much load", { status: 429 }))
      .mockResolvedValueOnce(new Response(envelope([], { changes: 1 }), { status: 200 }));
    await expect(settle(client(f).run(CLAIM, [7]))).resolves.toEqual({ changes: 1 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("з { idempotent: true } запис повторюється після мережевого збою", async () => {
    const f = vi.fn()
      .mockRejectedValueOnce(netError())
      .mockResolvedValueOnce(new Response(envelope([], { changes: 1 }), { status: 200 }));
    await expect(settle(client(f).run("INSERT OR IGNORE INTO people(id) VALUES (?)", [1], { idempotent: true })))
      .resolves.toEqual({ changes: 1 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("query з RETURNING на UPDATE теж не повторюється без згоди", async () => {
    const f = vi.fn().mockRejectedValueOnce(netError()).mockResolvedValue(new Response(okBody, { status: 200 }));
    await expect(settle(client(f).query(`${CLAIM} RETURNING id`, [7]))).rejects.toThrow(/fetch failed/);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("WITH, що пише, і кілька інструкцій в одному рядку не вважаються читанням", async () => {
    for (const sql of ["WITH x AS (SELECT 1) DELETE FROM t", "SELECT 1; DELETE FROM t"]) {
      const f = vi.fn().mockRejectedValueOnce(netError()).mockResolvedValue(new Response(okBody, { status: 200 }));
      await expect(settle(client(f).execute(sql))).rejects.toThrow();
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it("batch із записом не повторюється, batch із самих читань повторюється", async () => {
    const w = vi.fn().mockRejectedValueOnce(netError()).mockResolvedValue(new Response(okBody, { status: 200 }));
    await expect(settle(client(w).batch([{ sql: "SELECT 1" }, { sql: CLAIM, params: [1] }]))).rejects.toThrow();
    expect(w).toHaveBeenCalledTimes(1);

    const r = vi.fn().mockRejectedValueOnce(netError()).mockResolvedValue(new Response(okBody, { status: 200 }));
    await expect(settle(client(r).batch([{ sql: "SELECT 1" }, { sql: "SELECT 2" }]))).resolves.toBeUndefined();
    expect(r).toHaveBeenCalledTimes(2);
  });
});

describe("D1Client і бюджет cloudflare", () => {
  it("паралельні запити до D1 стартують не частіше за бюджет cloudflare", async () => {
    const t = timed([() => new Response(okBody, { status: 200 })]);
    const c = new D1Client(creds, { fetchImpl: t.f, retryDelayMs: 0 });
    await settle(Promise.all([c.query("SELECT 1"), c.query("SELECT 2"), c.query("SELECT 3")]));
    expect(t.at).toEqual([0, 250, 500]);
  });

  it("429 від D1 зупиняє й інших клієнтів того самого акаунта", async () => {
    const a = timed([
      () => new Response("wait", { status: 429, headers: { "retry-after": "7" } }),
      () => new Response(okBody, { status: 200 }),
    ]);
    const b = timed([() => new Response(okBody, { status: 200 })]);
    const pa = new D1Client(creds, { fetchImpl: a.f, attempts: 2, retryDelayMs: 0 }).query("SELECT 1");
    pa.catch(() => undefined);
    await vi.advanceTimersByTimeAsync(10);
    const pb = new D1Client(creds, { fetchImpl: b.f, retryDelayMs: 0 }).query("SELECT 2");
    await settle(Promise.all([pa, pb]));
    expect(b.at[0]!).toBeGreaterThanOrEqual(7_000);
  });
});
