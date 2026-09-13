import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, crmDb, run } from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { hmacSha256Hex } from "@/lib/auth/hash";
import {
  digestEmailResponse,
  MAX_BODY_BYTES,
  MAX_SKEW_SECONDS,
  SIGNATURE_HEADER,
  type DigestEmailPayload,
} from "./email";

const SECRET = "internal-secret-0123456789abcdef";
const NOW = new Date("2026-09-12T07:05:00Z");
const NOW_S = Math.floor(NOW.getTime() / 1000);
const URL_ = "https://nextcryptojob.xyz/api/internal/digest-email";

let t: TestDb;
let sent: Array<Record<string, unknown>>;
let binding: SendEmail;
let failNext: Error | null;

/** Підпис так, як його рахує engine (deliver.ts signBody): node:crypto над рядком тіла. */
const sign = (body: string, secret = SECRET) => `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;

function payload(over: Partial<DigestEmailPayload> = {}): DigestEmailPayload {
  return {
    version: 1,
    digest_id: "dg_ada1",
    user_id: "ada",
    local_date: "2026-09-12",
    ts: NOW_S,
    jobs: [
      {
        position: 1,
        title: "Protocol Engineer",
        company: "Paying Labs",
        location: "Remote",
        salary: "$120k to $150k",
        why: "Matches your Engineer role. Remote. Salary listed: $120k to $150k.",
        url: "https://jobs.example.com/1",
        posted_by: null,
        source: "nextrole",
      },
      {
        position: 2,
        title: "Solidity Auditor",
        company: "Acme",
        location: null,
        salary: null,
        why: "Matches your Security auditor role. Remote.",
        url: "https://nextcryptojob.xyz/jobs/job_x",
        posted_by: "Acme",
        source: "company",
      },
    ],
    ...over,
  };
}

function request(body: string, headers: Record<string, string> = { [SIGNATURE_HEADER]: sign(body) }, url = URL_): Request {
  return new Request(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
}

type Env = { INTERNAL_API_SECRET?: string; SESSION_SECRET?: string; EMAIL?: SendEmail; SITE_URL?: string };

async function post(body: string, opts: { headers?: Record<string, string>; env?: Env; now?: Date; url?: string } = {}) {
  const env = opts.env ?? { INTERNAL_API_SECRET: SECRET, EMAIL: binding };
  return digestEmailResponse(request(body, opts.headers, opts.url), { db: t.d1, env, now: () => opts.now ?? NOW });
}

const signedPost = (p: DigestEmailPayload, opts: { env?: Env; now?: Date } = {}) => post(JSON.stringify(p), opts);
const claims = () => all(t.raw, "SELECT digest_id, status, attempts, error FROM digest_emails");

beforeEach(() => {
  t = crmDb();
  run(t.raw, "INSERT INTO users (id, email) VALUES ('ada', 'ada@example.com'), ('bob', 'bob@example.com'), ('tg', NULL)");
  run(
    t.raw,
    `INSERT INTO digest_runs (id, user_id, local_date, status, jobs, channel) VALUES
       ('dg_ada1', 'ada', '2026-09-12', 'pending', 2, 'email'),
       ('dg_bob1', 'bob', '2026-09-12', 'pending', 2, 'email'),
       ('dg_tg1', 'tg', '2026-09-12', 'pending', 2, 'telegram')`,
  );
  sent = [];
  failNext = null;
  binding = {
    send: vi.fn(async (m: Record<string, unknown>) => {
      if (failNext) {
        const e = failNext;
        failNext = null;
        throw e;
      }
      sent.push(m);
      return { messageId: `m${sent.length}` };
    }),
  } as unknown as SendEmail;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

describe("signature", () => {
  it("sends the email when the HMAC of the raw body matches", async () => {
    const res = await signedPost(payload());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, digest_id: "dg_ada1", jobs: 2, dropped: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { email: "jobs@nextcryptojob.xyz", name: "NextCryptoJob" },
      to: "ada@example.com",
      subject: "Your 2 crypto jobs for Sep 12",
    });
    expect(claims()).toEqual([{ digest_id: "dg_ada1", status: "sent", attempts: 1, error: null }]);
  });

  it("answers 401 to a signature made with another secret", async () => {
    const body = JSON.stringify(payload());
    const res = await post(body, { headers: { [SIGNATURE_HEADER]: sign(body, "not-the-secret") } });
    expect(res.status).toBe(401);
    expect(sent).toEqual([]);
    expect(claims()).toEqual([]);
  });

  it("answers 401 without the header or with a header of the wrong shape", async () => {
    const body = JSON.stringify(payload());
    expect((await post(body, { headers: {} })).status).toBe(401);
    const hex = sign(body).slice("sha256=".length);
    for (const value of [hex, `sha1=${hex}`, `sha256=${hex.slice(2)}`, "sha256=zz"]) {
      expect((await post(body, { headers: { [SIGNATURE_HEADER]: value } })).status).toBe(401);
    }
    expect(sent).toEqual([]);
  });

  it("answers 401 when the body changed after signing, even by one byte", async () => {
    const body = JSON.stringify(payload());
    const tampered = body.replace('"user_id":"ada"', '"user_id":"bob"');
    expect(tampered).not.toBe(body);
    expect((await post(tampered, { headers: { [SIGNATURE_HEADER]: sign(body) } })).status).toBe(401);
    // Той самий JSON з іншим пробілом теж інші байти: підпис над сирим тілом, не над розібраним.
    const spaced = body.replace('"version":1', '"version": 1');
    expect((await post(spaced, { headers: { [SIGNATURE_HEADER]: sign(body) } })).status).toBe(401);
    expect(sent).toEqual([]);
  });

  it("answers 503 when the server has no INTERNAL_API_SECRET, before reading anything", async () => {
    const res = await signedPost(payload(), { env: { EMAIL: binding } });
    expect(res.status).toBe(503);
    expect(sent).toEqual([]);
  });

  it("answers 400 to a signed body that does not match the contract", async () => {
    for (const body of ["not json", JSON.stringify({ ...payload(), version: 2 }), JSON.stringify({ ...payload(), jobs: [] })]) {
      expect((await post(body)).status).toBe(400);
    }
    expect(sent).toEqual([]);
  });
});

describe("body size", () => {
  it("answers 413 from Content-Length alone, without reading the body", async () => {
    const body = JSON.stringify(payload());
    const res = await post(body, { headers: { [SIGNATURE_HEADER]: sign(body), "Content-Length": String(MAX_BODY_BYTES + 1) } });
    expect(res.status).toBe(413);
    expect(sent).toEqual([]);
  });

  it("answers 413 to a streamed body without a length once it passes 64 KB", async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled += 16 * 1024;
        c.enqueue(new Uint8Array(16 * 1024).fill(0x20));
        if (pulled > 10 * MAX_BODY_BYTES) c.close();
      },
    });
    const req = new Request(URL_, { method: "POST", headers: { [SIGNATURE_HEADER]: "sha256=" + "0".repeat(64) }, body: stream, duplex: "half" } as RequestInit);
    const res = await digestEmailResponse(req, { db: t.d1, env: { INTERNAL_API_SECRET: SECRET, EMAIL: binding }, now: () => NOW });
    expect(res.status).toBe(413);
    // Читання обірвали одразу за межею, а не дочитали все.
    expect(pulled).toBeLessThan(MAX_BODY_BYTES + 64 * 1024);
  });

  it("accepts a streamed body under the limit", async () => {
    const body = JSON.stringify(payload());
    const bytes = new TextEncoder().encode(body);
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, 100));
        c.enqueue(bytes.slice(100));
        c.close();
      },
    });
    const req = new Request(URL_, { method: "POST", headers: { [SIGNATURE_HEADER]: sign(body) }, body: stream, duplex: "half" } as RequestInit);
    const res = await digestEmailResponse(req, { db: t.d1, env: { INTERNAL_API_SECRET: SECRET, EMAIL: binding }, now: () => NOW });
    expect(res.status).toBe(200);
  });
});

describe("jobs", () => {
  it("drops invalid jobs one by one and sends the rest", async () => {
    const p = payload();
    const [good, second] = p.jobs;
    const bad = [
      { ...good, position: 3, company: "" },
      { ...good, position: 4, url: `https://jobs.example.com/${"x".repeat(2048)}` },
      { ...good, position: 5, title: "   " },
      { position: 6 },
    ];
    const res = await post(JSON.stringify({ ...p, jobs: [good, ...bad, second] }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ jobs: 2, dropped: 4 });
    expect(sent[0].subject).toBe("Your 2 crypto jobs for Sep 12");
  });

  it("answers 400 when no valid job is left", async () => {
    const p = payload();
    const res = await post(JSON.stringify({ ...p, jobs: p.jobs.map((j) => ({ ...j, company: "" })) }));
    expect(res.status).toBe(400);
    expect(sent).toEqual([]);
    expect(claims()).toEqual([]);
  });
});

describe("ts window", () => {
  it(`accepts ts up to ${MAX_SKEW_SECONDS} s off in either direction`, async () => {
    expect((await signedPost(payload({ ts: NOW_S - MAX_SKEW_SECONDS }))).status).toBe(200);
    expect((await signedPost(payload({ digest_id: "dg_bob1", user_id: "bob", ts: NOW_S + MAX_SKEW_SECONDS }))).status).toBe(200);
  });

  it("answers 401 to a replay older than 300 s and to a ts far in the future", async () => {
    expect((await signedPost(payload({ ts: NOW_S - MAX_SKEW_SECONDS - 1 }))).status).toBe(401);
    expect((await signedPost(payload({ ts: NOW_S + MAX_SKEW_SECONDS + 1 }))).status).toBe(401);
    expect(sent).toEqual([]);
    expect(claims()).toEqual([]);
  });
});

describe("idempotency by digest_id", () => {
  it("never sends a second email for the same digest_id and answers 409, which engine reads as delivered", async () => {
    expect((await signedPost(payload())).status).toBe(200);
    // Повтор engine після обриву мережі: новий ts, той самий digest_id.
    const again = await signedPost(payload({ ts: NOW_S + 5 }), { now: new Date(NOW.getTime() + 5000) });
    expect(again.status).toBe(409);
    expect(sent).toHaveLength(1);
    expect(claims()).toEqual([{ digest_id: "dg_ada1", status: "sent", attempts: 1, error: null }]);
  });

  it("answers 425, not delivered, while another request for the digest is still sending", async () => {
    run(t.raw, "INSERT INTO digest_emails (digest_id) VALUES ('dg_ada1')");
    expect((await signedPost(payload())).status).toBe(425);
    expect(sent).toEqual([]);
    expect(claims()).toEqual([{ digest_id: "dg_ada1", status: "sending", attempts: 1, error: null }]);
  });

  it("takes over a sending claim older than 5 minutes (the isolate died) and sends", async () => {
    run(t.raw, "INSERT INTO digest_emails (digest_id, updated_at) VALUES ('dg_ada1', datetime('now', '-6 minutes'))");
    expect((await signedPost(payload())).status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(claims()).toEqual([{ digest_id: "dg_ada1", status: "sent", attempts: 2, error: null }]);
  });

  it("two requests at once: exactly one email, the other one 425", async () => {
    // Поштовий сервіс відповідає повільно: другий запит приходить, поки перший ще шле.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const send = vi.fn(async (m: Record<string, unknown>) => {
      await gate;
      sent.push(m);
      return { messageId: "m1" };
    });
    binding = { send } as unknown as SendEmail;
    const both = Promise.all([signedPost(payload()), signedPost(payload({ ts: NOW_S + 1 }))]);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    release();
    const [a, b] = await both;
    expect([a.status, b.status].sort()).toEqual([200, 425]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(1);
  });

  it("answers 502 when the email service fails, and the retry sends it", async () => {
    failNext = Object.assign(new Error("rate limited for ada@example.com"), { code: "E_RATE_LIMIT_EXCEEDED" });
    const first = await signedPost(payload());
    expect(first.status).toBe(502);
    expect(claims()).toEqual([{ digest_id: "dg_ada1", status: "failed", attempts: 1, error: "E_RATE_LIMIT_EXCEEDED" }]);
    // У базу й журнал лише код, без адреси з тексту помилки.
    expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain("ada@example.com");

    const retry = await signedPost(payload());
    expect(retry.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(claims()).toEqual([{ digest_id: "dg_ada1", status: "sent", attempts: 2, error: null }]);
  });

  it.each([
    ["E_RECIPIENT_SUPPRESSED", 422],
    ["E_RECIPIENT_NOT_ALLOWED", 422],
    ["E_HEADER_NOT_ALLOWED", 422],
    ["E_SENDER_NOT_VERIFIED", 503],
    ["E_SENDER_DOMAIN_NOT_AVAILABLE", 503],
    ["E_INTERNAL_SERVER_ERROR", 502],
    ["E_SOMETHING_NEW", 502],
  ])("answers %s from the email service with %i", async (code, status) => {
    failNext = Object.assign(new Error("refused"), { code });
    const res = await signedPost(payload());
    expect(res.status).toBe(status);
    expect(claims()).toEqual([{ digest_id: "dg_ada1", status: "failed", attempts: 1, error: code }]);
  });

  it("logs, without the address, when the failed status cannot be saved", async () => {
    failNext = Object.assign(new Error("suppressed ada@example.com"), { code: "E_RECIPIENT_SUPPRESSED" });
    // Заявку пише INSERT; UPDATE на 'failed' падає, як упала б зайнята база.
    const d1 = t.d1;
    const flaky = {
      ...d1,
      prepare: (sql: string) => {
        if (sql.startsWith("UPDATE digest_emails SET status = 'failed'")) throw new Error("D1_ERROR: database is locked");
        return d1.prepare(sql);
      },
      batch: d1.batch.bind(d1),
    } as unknown as D1Database;
    const body = JSON.stringify(payload());
    const res = await digestEmailResponse(request(body), { db: flaky, env: { INTERNAL_API_SECRET: SECRET, EMAIL: binding }, now: () => NOW });
    expect(res.status).toBe(422);
    const logged = JSON.stringify(vi.mocked(console.warn).mock.calls);
    expect(logged).toContain("failed status not saved (D1_ERROR: database is locked)");
    expect(logged).not.toContain("ada@example.com");
  });

  it("keeps separate digests separate", async () => {
    expect((await signedPost(payload())).status).toBe(200);
    expect((await signedPost(payload({ digest_id: "dg_bob1", user_id: "bob" }))).status).toBe(200);
    expect(sent.map((m) => m.to)).toEqual(["ada@example.com", "bob@example.com"]);
  });
});

describe("who gets it", () => {
  it("answers 404 when the user is gone", async () => {
    run(t.raw, "DELETE FROM users WHERE id = 'ada'");
    const res = await signedPost(payload());
    expect(res.status).toBe(404);
    expect(sent).toEqual([]);
  });

  it("answers 422 when the user has no email", async () => {
    const res = await signedPost(payload({ digest_id: "dg_tg1", user_id: "tg" }));
    expect(res.status).toBe(422);
    expect(sent).toEqual([]);
    expect(claims()).toEqual([]);
  });

  it("answers 404 when the digest belongs to someone else, and emails nobody", async () => {
    const res = await signedPost(payload({ digest_id: "dg_bob1", user_id: "ada" }));
    expect(res.status).toBe(404);
    expect(sent).toEqual([]);
    expect(claims()).toEqual([]);
  });

  it("answers 503 email not configured without the EMAIL binding, and claims nothing", async () => {
    const res = await signedPost(payload(), { env: { INTERNAL_API_SECRET: SECRET } });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "email not configured" });
    expect(claims()).toEqual([]);
  });
});

describe("email content", () => {
  it("escapes job fields from the boards in HTML and links only http(s) addresses", async () => {
    const p = payload();
    p.jobs[0] = {
      ...p.jobs[0],
      title: `<script>alert("x")</script> Engineer`,
      company: `A&B "Labs"`,
      url: "javascript:alert(1)",
    };
    expect((await signedPost(p)).status).toBe(200);
    const html = String(sent[0].html);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; Engineer");
    expect(html).toContain("A&amp;B &quot;Labs&quot;");
    expect(html).not.toContain("javascript:");
    // Простий текст лишається читабельним, без сутностей.
    expect(String(sent[0].text)).toContain(`1. <script>alert("x")</script> Engineer`);
  });

  it("links the site from SITE_URL, never from the host the request came to", async () => {
    const body = JSON.stringify(payload());
    await post(body, { url: "https://evil.example/api/internal/digest-email" });
    expect(String(sent[0].text)).toContain("https://nextcryptojob.xyz/settings");
    expect(String(sent[0].html)).not.toContain("evil.example");

    sent = [];
    await post(JSON.stringify(payload({ digest_id: "dg_bob1", user_id: "bob" })), {
      env: { INTERNAL_API_SECRET: SECRET, EMAIL: binding, SITE_URL: "https://staging.nextcryptojob.xyz" },
    });
    expect(String(sent[0].text)).toContain("https://staging.nextcryptojob.xyz/settings");
  });

  it("carries one-click unsubscribe headers and a visible pause link signed for this person", async () => {
    await post(JSON.stringify(payload()), { env: { INTERNAL_API_SECRET: SECRET, SESSION_SECRET: "session-key", EMAIL: binding } });
    const token = await hmacSha256Hex("session-key", "unsub:ada");
    const url = `https://nextcryptojob.xyz/api/digest/unsubscribe?u=ada&t=${token}`;
    expect(sent[0].headers).toEqual({ "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(String(sent[0].text)).toContain(`Pause daily jobs: ${url}`);
    expect(String(sent[0].html)).toContain(`href="${url.replace(/&/g, "&amp;")}"`);
  });
});
