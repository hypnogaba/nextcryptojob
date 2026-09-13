import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getAction, type ActionDef } from "@/lib/crm/actions";
import { paymentHeader, requiredFrom, rest, setupApi } from "@/test/api-fixtures";
import { addApiKey, addCompany, addScore, addUser, all, publishFormula, run } from "@/test/crm-fixtures";
import { addCandidate, MESSAGE, type Network } from "@/test/intro-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { POST } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

/**
 * Гроші розраховано, а результату немає (специфікація 7.4, «Paid without result»), і повтор
 * у проміжку між settle і записом результату. Фасилітатор на заглушці (stubNetwork).
 */

const post = (path: string, o: Parameters<typeof rest>[3] = {}) => rest(POST, "POST", path, o);

let db: TestDb;
let net: Network;

beforeEach(() => {
  ({ db, net } = setupApi());
  publishFormula(db.raw);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function engineer(): string {
  const id = addUser(db.raw);
  addScore(db.raw, id, "engineer", 70);
  return id;
}

async function payPerRequestKey(): Promise<{ co: string; key: string }> {
  const co = addCompany(db.raw);
  const { key } = await addApiKey(db.raw, co);
  return { co, key };
}

const payment = () =>
  all<{ id: string; status: string; no_result_at: string | null; no_result_reason: string | null }>(
    db.raw,
    "SELECT id, status, no_result_at, no_result_reason FROM x402_payments",
  );
const usage = () => all<{ status: number }>(db.raw, "SELECT status FROM usage_events");

/** Оплачений пошук гостя з payment-identifier: перший запит і заголовок для повторів. */
async function paidSearch(identifier: string) {
  const header = paymentHeader(requiredFrom(await post("/candidates/search", { body: {} })), identifier);
  return { header, first: await post("/candidates/search", { body: {}, payment: header }) };
}

describe("the result cannot be saved after settle", () => {
  it("answers 500 with the payment id and no data, lists the payment as paid without result and frees the quota", async () => {
    engineer();
    const batch = db.d1.batch.bind(db.d1);
    // Облік і журнал пишуться одним пакетом лише після settle: цей пакет і падає.
    vi.spyOn(db.d1, "batch").mockImplementation(async (statements: D1PreparedStatement[]) => {
      if (statements.some((s) => String((s as unknown as { sql: string }).sql).includes("INSERT INTO audit_log"))) {
        throw new Error("D1_ERROR: Network connection lost.");
      }
      return batch(statements);
    });
    const { header, first } = await paidSearch("commit_fails_0123456789");
    expect(first.status).toBe(500);
    expect(first.body).not.toHaveProperty("data");
    const [pay] = payment();
    expect(first.body.error).toMatchObject({ code: "internal", details: { payment_id: pay.id, transaction: "0xtx1" } });
    expect(pay).toMatchObject({ status: "settled", no_result_at: expect.any(String) });
    expect(pay.no_result_reason).toMatch(/^commit_failed: D1_ERROR/);
    expect(usage()).toEqual([{ status: 500 }]);

    // Повтор того самого платежу: остаточна 500, не 409 «повторіть» і не другий settle.
    vi.restoreAllMocks();
    const again = await post("/candidates/search", { body: {}, payment: header });
    expect(again.status).toBe(500);
    expect(again.body.error.details.payment_id).toBe(pay.id);
    expect(net.settle).toBe(1);
  });

  it("an intro that fails after settle is paid without result: nobody is asked and the pair is free again", async () => {
    const { key } = await payPerRequestKey();
    const alice = addCandidate(db);
    const def = getAction("request_intro") as ActionDef;
    const original = def.handler!;
    def.handler = async () => {
      throw new Error("D1_ERROR: database is locked");
    };
    try {
      const input = { candidate_id: alice.id, message: MESSAGE };
      const header = paymentHeader(requiredFrom(await post("/intros", { key, body: input })), "intro_fails_0123456789");
      const res = await post("/intros", { key, body: input, payment: header });
      expect(res.status).toBe(500);
      expect(res.body.error.message).toBe("Payment was received but the action failed. Contact support with the payment id.");
      expect(payment()[0].no_result_reason).toMatch(/^action_failed: D1_ERROR: database is locked/);
      expect(all(db.raw, "SELECT id FROM intros")).toEqual([]);
      expect(usage()).toEqual([{ status: 500 }]);
      expect(net.messagesTo(alice.telegramId!)).toEqual([]);
      expect((await post("/intros", { key, body: input, payment: header })).status).toBe(500);
      expect(net.settle).toBe(1);
    } finally {
      def.handler = original;
    }
  });
});

describe("a replay between settle and the stored result", () => {
  it("while the first request is still running, the replay is a 409 to retry, then gets the same intro", async () => {
    const { key } = await payPerRequestKey();
    const alice = addCandidate(db);
    const def = getAction("request_intro") as ActionDef;
    const original = def.handler!;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    def.handler = async (ctx, input) => {
      await gate;
      return original(ctx, input);
    };
    try {
      const input = { candidate_id: alice.id, message: MESSAGE };
      const unpaid = await post("/intros", { key, body: input });
      expect(unpaid.headers.get("RateLimit-Limit")).toBe("10");
      expect(unpaid.headers.get("RateLimit-Remaining")).toBe("10");
      const header = paymentHeader(requiredFrom(unpaid), "intro_inflight_0123456789");
      const running = post("/intros", { key, body: input, payment: header });
      while (net.settle < 1) await new Promise((r) => setTimeout(r, 1));

      const early = await post("/intros", { key, body: input, payment: header });
      expect(early.status).toBe(409);
      expect(early.body.error).toMatchObject({
        code: "payment_reused",
        message: "This payment is still being processed. Retry in a few seconds.",
        details: { payment_id: payment()[0].id },
      });

      open();
      const done = await running;
      expect(done.status).toBe(201);
      const later = await post("/intros", { key, body: input, payment: header });
      expect(later.status).toBe(201);
      expect(later.body.intro_id).toBe(done.body.intro_id);
      expect(later.headers.get("RateLimit-Remaining")).toBe("9");
      expect(net.settle).toBe(1);
      expect(net.messagesTo(alice.telegramId!)).toHaveLength(1);
      expect(payment()[0].no_result_at).toBeNull();
    } finally {
      def.handler = original;
    }
  });

  it("a fresh settle with no stored result yet is a 409; an old one becomes paid without result", async () => {
    engineer();
    const { header, first } = await paidSearch("search_gone_0123456789");
    expect(first.status).toBe(200);
    run(db.raw, "DELETE FROM audit_log");

    const fresh = await post("/candidates/search", { body: {}, payment: header });
    expect(fresh.status).toBe(409);
    expect(fresh.body.error.code).toBe("payment_reused");

    run(db.raw, "UPDATE x402_payments SET settled_at = datetime('now', '-10 minutes')");
    const old = await post("/candidates/search", { body: {}, payment: header });
    expect(old.status).toBe(500);
    expect(old.body.error.details.payment_id).toBe(payment()[0].id);
    expect(payment()[0].no_result_reason).toMatch(/^no_result_after_settle/);
    expect(usage()).toEqual([{ status: 500 }]);
    expect(net.settle).toBe(1);
  });

  it("a replay that finds the stored page also carries the RateLimit headers of the payer", async () => {
    engineer();
    const { header, first } = await paidSearch("search_headers_0123456789");
    expect(first.headers.get("RateLimit-Remaining")).toBe("49");
    const again = await post("/candidates/search", { body: {}, payment: header });
    expect(again.status).toBe(200);
    expect(again.headers.get("RateLimit-Limit")).toBe("50");
    expect(again.headers.get("RateLimit-Remaining")).toBe("49");
  });
});

describe("request body limit", () => {
  it("counts bytes, not characters", async () => {
    const { key } = await payPerRequestKey();
    // 40 000 символів «é» = 80 000 байтів UTF-8: більше за межу в 64 КіБ, хоч символів менше.
    const res = await post("/intros", { key, raw: JSON.stringify({ message: "é".repeat(40_000) }) });
    expect(res.status).toBe(422);
    expect(res.body.error.details.fields).toEqual({ "(body)": "The request body is too large." });
    expect(net.verify).toBe(0);
  });
});
