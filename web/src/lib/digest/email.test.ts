import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { all, crmDb, run } from "@/test/crm-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { digestEmailResponse, MAX_SKEW_SECONDS, SIGNATURE_HEADER, type DigestEmailPayload } from "./email";

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

function request(body: string, headers: Record<string, string> = { [SIGNATURE_HEADER]: sign(body) }): Request {
  return new Request(URL_, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
}

type Env = { INTERNAL_API_SECRET?: string; EMAIL?: SendEmail };

async function post(body: string, opts: { headers?: Record<string, string>; env?: Env; now?: Date } = {}) {
  const env = opts.env ?? { INTERNAL_API_SECRET: SECRET, EMAIL: binding };
  return digestEmailResponse(request(body, opts.headers), { db: t.d1, env, now: () => opts.now ?? NOW });
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
    expect(await res.json()).toEqual({ ok: true, digest_id: "dg_ada1" });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      from: { email: "login@nextcryptojob.xyz", name: "NextCryptoJob" },
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

  it("answers 409 while the first request for the digest is still sending", async () => {
    run(t.raw, "INSERT INTO digest_emails (digest_id) VALUES ('dg_ada1')");
    expect((await signedPost(payload())).status).toBe(409);
    expect(sent).toEqual([]);
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

  it("links the settings page from the site the request came to", async () => {
    await signedPost(payload());
    expect(String(sent[0].text)).toContain("https://nextcryptojob.xyz/settings");
    expect(String(sent[0].html)).toContain('href="https://nextcryptojob.xyz/settings"');
  });
});
