import { createHmac, timingSafeEqual } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetLimiters } from "../limits.js";
import {
  deliverDigest, type DigestMessage, EMAIL_NOT_CONFIGURED, planChannel, SIGNATURE_HEADER, sendTelegram, telegramText,
  TELEGRAM_NOT_CONFIGURED,
} from "./deliver.js";

type Call = { url: string; init: RequestInit };

/** fetch, що віддає відповіді по черзі й записує виклики. */
function fakeFetch(responses: Array<Response | Error>) {
  const calls: Call[] = [];
  const impl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error("no more responses");
    if (next instanceof Error) throw next;
    return next;
  }) as unknown as typeof fetch;
  return { impl, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const MESSAGE: DigestMessage = {
  digestId: "dg_1", userId: "user-1", localDate: "2026-09-12",
  jobs: [
    { position: 1, title: "Posted <Solidity> Engineer — L3", company: "Acme & Co", location: "Remote", salary: "$120k to $150k",
      why: "Matches your Engineer role. Remote.", url: "https://jobs.example/1?a=1&b=2", postedBy: null, source: "nextrole" },
    { position: 2, title: "Protocol Engineer", company: "Beta", location: null, salary: null,
      why: "Matches your Engineer role. Remote.", url: "https://nextcryptojob.xyz/jobs/job_1", postedBy: "Beta", source: "company" },
  ],
};

const TG_USER = { id: "user-1", channel: "telegram", email: "a@example.com", telegramId: "12345" };
const ENV = { TELEGRAM_BOT_TOKEN: "123:SECRET", SITE_URL: "https://nextcryptojob.xyz", INTERNAL_API_SECRET: "s3cret" };
const sleeps: number[] = [];
const sleep = async (ms: number) => { sleeps.push(ms); };

beforeEach(() => { __resetLimiters(); sleeps.length = 0; });

describe("planChannel", () => {
  it("Telegram без токена бота: людину пропускаємо, нічого не палимо", () => {
    expect(planChannel(TG_USER, {})).toEqual({ skip: TELEGRAM_NOT_CONFIGURED });
  });
  it("канал email, але пошти немає: Telegram", () => {
    expect(planChannel({ ...TG_USER, channel: "email", email: null }, ENV)).toEqual({ primary: "telegram", emailFallback: false });
  });
  it("канал telegram без прив'язки: пошта", () => {
    expect(planChannel({ ...TG_USER, telegramId: null }, ENV)).toEqual({ primary: "email", emailFallback: false });
  });
  it("ні пошти, ні Telegram: пропуск з причиною", () => {
    expect(planChannel({ ...TG_USER, telegramId: null, email: null }, ENV)).toHaveProperty("skip");
  });
});

describe("Telegram", () => {
  it("одне повідомлення HTML з п'ятьма полями вакансії; дані екрановано, довгого тире немає", async () => {
    const f = fakeFetch([json(200, { ok: true, result: {} })]);
    const r = await deliverDigest(TG_USER, MESSAGE, { primary: "telegram", emailFallback: true }, { env: ENV, fetchImpl: f.impl, sleep });
    expect(r).toEqual({ status: "sent", channel: "telegram", note: null });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]!.url).toBe("https://api.telegram.org/bot123:SECRET/sendMessage");
    const body = JSON.parse(String(f.calls[0]!.init.body)) as { chat_id: string; text: string; parse_mode: string };
    expect(body.chat_id).toBe("12345");
    expect(body.parse_mode).toBe("HTML");
    expect(body.text).toContain("Posted &lt;Solidity&gt; Engineer - L3");
    expect(body.text).toContain('href="https://jobs.example/1?a=1&amp;b=2"');
    expect(body.text).toContain("Acme &amp; Co · Remote · $120k to $150k");
    expect(body.text).toContain("<i>Matches your Engineer role. Remote.</i>");
    expect(body.text).toContain("Posted by Beta on NextCryptoJob");
    expect(body.text).not.toMatch(/—/);
  });

  it("429: чекає retry_after і пробує ще", async () => {
    const f = fakeFetch([json(429, { ok: false, description: "Too Many Requests", parameters: { retry_after: 3 } }), json(200, { ok: true })]);
    const r = await sendTelegram("t", "1", "hi", { env: ENV, fetchImpl: f.impl, sleep });
    expect(r).toEqual({ ok: true });
    expect(sleeps).toEqual([3000]);
    expect(f.calls).toHaveLength(2);
  });

  it("бот заблокований (403): failed у Telegram і лист, якщо пошта є", async () => {
    const f = fakeFetch([json(403, { ok: false, description: "Forbidden: bot was blocked by the user" }), new Response(null, { status: 202 })]);
    const r = await deliverDigest(TG_USER, MESSAGE, { primary: "telegram", emailFallback: true }, { env: ENV, fetchImpl: f.impl, sleep });
    expect(r).toMatchObject({ status: "sent", channel: "email" });
    expect(r.status === "sent" && r.note).toMatch(/telegram 403.*blocked.*sent by email instead/);
    expect(f.calls[1]!.url).toBe("https://nextcryptojob.xyz/api/internal/digest-email");
  });

  it("бот заблокований і пошти немає: failed з причиною", async () => {
    const f = fakeFetch([json(403, { ok: false, description: "Forbidden: bot was blocked by the user" })]);
    const r = await deliverDigest({ ...TG_USER, email: null }, MESSAGE, { primary: "telegram", emailFallback: false }, { env: ENV, fetchImpl: f.impl, sleep });
    expect(r).toMatchObject({ status: "failed", channel: "telegram" });
    expect(f.calls).toHaveLength(1);
  });

  it("інша помилка Telegram (400 розмітка) не веде в лист: причина не в людині", async () => {
    const f = fakeFetch([json(400, { ok: false, description: "Bad Request: can't parse entities" })]);
    const r = await deliverDigest(TG_USER, MESSAGE, { primary: "telegram", emailFallback: true }, { env: ENV, fetchImpl: f.impl, sleep });
    expect(r).toMatchObject({ status: "failed", channel: "telegram" });
    expect(f.calls).toHaveLength(1);
  });

  it("мережевий збій: токен не потрапляє в причину", async () => {
    const f = fakeFetch([new TypeError("fetch failed https://api.telegram.org/bot123:SECRET/sendMessage")]);
    const r = await deliverDigest(TG_USER, MESSAGE, { primary: "telegram", emailFallback: false }, { env: ENV, fetchImpl: f.impl, sleep });
    expect(r.status).toBe("failed");
    expect(JSON.stringify(r)).not.toContain("SECRET");
  });

  it("вакансія компанії з поштою замість адреси: без href, адреса окремим рядком", () => {
    const mail = { ...MESSAGE, jobs: [{ ...MESSAGE.jobs[1]!, position: 1, url: "mailto:jobs@beta.example?subject=Hi" }] };
    const text = telegramText(mail, "https://nextcryptojob.xyz");
    expect(text).not.toContain("mailto:");
    expect(text).toContain("1. <b>Protocol Engineer</b>");
    expect(text).toContain("Apply: jobs@beta.example");
  });

  it("надто довге повідомлення обрізається до 4096 символів цілими вакансіями", () => {
    const long = { ...MESSAGE, jobs: Array.from({ length: 5 }, (_, i) => ({ ...MESSAGE.jobs[0]!, position: i + 1, why: "x".repeat(1500) })) };
    const text = telegramText(long, "https://nextcryptojob.xyz");
    expect(text.length).toBeLessThanOrEqual(4096);
    expect(text).toContain("your account");
  });
});

describe("лист через сайт", () => {
  it("підпис HMAC-SHA256 над сирим тілом у заголовку NCJ-Internal-Signature", async () => {
    const f = fakeFetch([new Response(null, { status: 200 })]);
    const now = new Date("2026-09-12T07:05:00Z");
    const r = await deliverDigest({ ...TG_USER, channel: "email" }, MESSAGE, { primary: "email", emailFallback: false },
      { env: ENV, fetchImpl: f.impl, sleep, now: () => now });
    expect(r).toEqual({ status: "sent", channel: "email", note: null });
    const raw = String(f.calls[0]!.init.body);
    const header = new Headers(f.calls[0]!.init.headers).get(SIGNATURE_HEADER)!;
    const expected = `sha256=${createHmac("sha256", "s3cret").update(raw).digest("hex")}`;
    expect(timingSafeEqual(Buffer.from(header), Buffer.from(expected))).toBe(true);
    const body = JSON.parse(raw) as Record<string, unknown>;
    expect(body).toMatchObject({ version: 1, digest_id: "dg_1", user_id: "user-1", local_date: "2026-09-12", ts: Date.parse("2026-09-12T07:05:00Z") / 1000 });
    expect((body.jobs as unknown[]).length).toBe(2);
    // Адреси людини в тілі немає: сайт бере її з users за user_id.
    expect(raw).not.toContain("a@example.com");
  });

  it("повтор після 5xx іде з новим ts і новим підписом", async () => {
    const f = fakeFetch([new Response(null, { status: 502 }), new Response(null, { status: 200 })]);
    const times = [new Date("2026-09-12T07:05:00Z"), new Date("2026-09-12T07:05:02Z")];
    let i = 0;
    const r = await deliverDigest(TG_USER, MESSAGE, { primary: "email", emailFallback: false },
      { env: ENV, fetchImpl: f.impl, sleep, now: () => times[Math.min(i++, 1)]! });
    expect(r).toMatchObject({ status: "sent", channel: "email" });
    const bodies = f.calls.map((c) => JSON.parse(String(c.init.body)) as { ts: number });
    expect(bodies.map((b) => b.ts)).toEqual([times[0]!.getTime() / 1000, times[1]!.getTime() / 1000]);
    const sig = (c: Call) => new Headers(c.init.headers).get(SIGNATURE_HEADER);
    expect(sig(f.calls[0]!)).not.toBe(sig(f.calls[1]!));
  });

  it("425 від сайту (лист цієї добірки ще в дорозі): failed без повтору", async () => {
    const f = fakeFetch([new Response(null, { status: 425 })]);
    const r = await deliverDigest(TG_USER, MESSAGE, { primary: "email", emailFallback: false }, { env: ENV, fetchImpl: f.impl, sleep });
    expect(r).toEqual({ status: "failed", channel: "email", error: "email endpoint HTTP 425" });
    expect(f.calls).toHaveLength(1);
  });

  it("503 від сайту = пошта ще не налаштована", async () => {
    const f = fakeFetch([new Response(null, { status: 503 })]);
    const r = await deliverDigest(TG_USER, MESSAGE, { primary: "email", emailFallback: false }, { env: ENV, fetchImpl: f.impl, sleep });
    expect(r).toEqual({ status: "failed", channel: "email", error: EMAIL_NOT_CONFIGURED });
  });

  it("без SITE_URL чи INTERNAL_API_SECRET: failed «email not configured», запиту немає", async () => {
    for (const env of [{ SITE_URL: "https://x.example" }, { INTERNAL_API_SECRET: "s" }, { SITE_URL: "http://x.example", INTERNAL_API_SECRET: "s" }]) {
      const f = fakeFetch([]);
      const r = await deliverDigest(TG_USER, MESSAGE, { primary: "email", emailFallback: false }, { env, fetchImpl: f.impl, sleep });
      expect(r).toEqual({ status: "failed", channel: "email", error: EMAIL_NOT_CONFIGURED });
      expect(f.calls).toHaveLength(0);
    }
  });

  it("мережевий збій повторюється один раз (сайт відкидає дубль за digest_id); 409 = уже відправлено", async () => {
    const f = fakeFetch([new TypeError("fetch failed"), new Response(null, { status: 409 })]);
    const r = await deliverDigest(TG_USER, MESSAGE, { primary: "email", emailFallback: false }, { env: ENV, fetchImpl: f.impl, sleep });
    expect(r).toMatchObject({ status: "sent", channel: "email" });
    expect(f.calls).toHaveLength(2);
    expect(sleeps).toEqual([2000]);
  });

  it("4xx від сайту: failed без повтору", async () => {
    const f = fakeFetch([new Response(null, { status: 401 })]);
    const r = await deliverDigest(TG_USER, MESSAGE, { primary: "email", emailFallback: false }, { env: ENV, fetchImpl: f.impl, sleep });
    expect(r).toEqual({ status: "failed", channel: "email", error: "email endpoint HTTP 401" });
    expect(f.calls).toHaveLength(1);
  });
});
