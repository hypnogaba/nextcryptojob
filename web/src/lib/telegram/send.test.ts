import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callTelegram, escapeHtml, retryDelayMs, sendMessage } from "./send";

const TOKEN = "123456:SECRET-token";
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

function replies(...responses: Response[]) {
  const calls: { url: string; body: Record<string, unknown> }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const next = responses.shift();
    if (!next) throw new Error("unexpected call");
    return next;
  });
  return { calls, fetchImpl };
}

const tooMany = (retryAfter?: number) =>
  Response.json(
    { ok: false, error_code: 429, description: "Too Many Requests", parameters: retryAfter ? { retry_after: retryAfter } : {} },
    { status: 429 },
  );

describe("retryDelayMs", () => {
  it("waits as long as Telegram asks, up to 5 seconds, and only on 429", () => {
    expect(retryDelayMs(429, { parameters: { retry_after: 3 } })).toBe(3000);
    expect(retryDelayMs(429, { parameters: { retry_after: 5 } })).toBe(5000);
    expect(retryDelayMs(429, { parameters: { retry_after: 6 } })).toBeNull();
    expect(retryDelayMs(429, null)).toBe(1000);
    expect(retryDelayMs(400, { parameters: { retry_after: 1 } })).toBeNull();
  });
});

describe("callTelegram", () => {
  it("retries once after a 429, honouring retry_after", async () => {
    const { calls, fetchImpl } = replies(tooMany(2), Response.json({ ok: true, result: { message_id: 1 } }));
    const sleep = vi.fn(async () => {});
    const res = await callTelegram(TOKEN, "sendMessage", { chat_id: 5, text: "hi" }, { fetchImpl, sleep });
    expect(res).toEqual({ ok: true, result: { message_id: 1 } });
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
  });

  it("gives up after the second 429", async () => {
    const { calls, fetchImpl } = replies(tooMany(1), tooMany(1));
    const res = await callTelegram(TOKEN, "sendMessage", { chat_id: 5 }, { fetchImpl, sleep: async () => {} });
    expect(res.ok).toBe(false);
    expect(calls).toHaveLength(2);
  });

  it("does not wait longer than 5 seconds", async () => {
    const { calls, fetchImpl } = replies(tooMany(30));
    const sleep = vi.fn(async () => {});
    const res = await callTelegram(TOKEN, "sendMessage", { chat_id: 5 }, { fetchImpl, sleep });
    expect(res.ok).toBe(false);
    expect(sleep).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
  });

  it("does not retry other errors and logs them without the token", async () => {
    const { calls, fetchImpl } = replies(
      Response.json({ ok: false, error_code: 403, description: "Forbidden: bot was blocked by the user" }, { status: 403 }),
    );
    const res = await callTelegram(TOKEN, "sendMessage", { chat_id: 5 }, { fetchImpl });
    expect(res.description).toMatch(/blocked/);
    expect(calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain(TOKEN);
  });

  it("survives a network error without leaking the token", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`fetch failed for https://api.telegram.org/bot${TOKEN}/sendMessage`);
    });
    await expect(callTelegram(TOKEN, "sendMessage", { chat_id: 5 }, { fetchImpl })).resolves.toEqual({
      ok: false,
      description: "network",
    });
    expect(String(warn.mock.calls[0][0])).not.toContain(TOKEN);
  });

  it("does nothing without a token", async () => {
    const fetchImpl = vi.fn();
    await expect(callTelegram(undefined, "sendMessage", {}, { fetchImpl })).resolves.toEqual({
      ok: false,
      description: "no token",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("sendMessage", () => {
  it("sends HTML without link previews", async () => {
    const { calls, fetchImpl } = replies(Response.json({ ok: true }));
    await sendMessage(TOKEN, 42, "<b>hi</b>", {}, { fetchImpl });
    expect(calls[0].body).toEqual({
      chat_id: 42,
      text: "<b>hi</b>",
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  it("escapes text for HTML parse mode", () => {
    expect(escapeHtml(`<a href="x">&</a>`)).toBe("&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;");
  });
});
