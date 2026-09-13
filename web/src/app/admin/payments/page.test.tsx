import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { markRefunded } from "@/lib/admin/payments";
import { createSession } from "@/lib/auth/session";
import { harness, RedirectCalled, resetHarness, rows } from "@/test/harness";
import { addCompany, addPayment, run } from "@/test/crm-fixtures";
import { markRefundedAction } from "./actions";
import AdminPaymentsPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

class NotFoundCalled extends Error {}
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  notFound: (): never => {
    throw new NotFoundCalled("notFound()");
  },
}));

/**
 * /admin/payments: «Paid without result» (специфікація 7.4) і позначка «Mark refunded».
 * Сторінка й дія пускають лише адміна, що ввійшов поштою.
 */

let paid: string;
let company: string;

beforeEach(() => {
  resetHarness({ ADMIN_EMAILS: "boss@example.com" } as never);
  run(harness.raw, "INSERT INTO users (id, email) VALUES ('boss', 'boss@example.com'), ('ada', 'ada@example.com')");
  company = addCompany(harness.raw, { name: "Acme Labs" });
  paid = addPayment(harness.raw, { companyId: company, payer: "0x2222222222222222222222222222222222222222" });
  run(
    harness.raw,
    `UPDATE x402_payments SET action = 'request_intro', amount_usd_cents = 500, tx = '0xabc123', network = 'eip155:84532',
            settled_at = '2026-09-13 10:00:00', no_result_at = '2026-09-13 10:00:01',
            no_result_reason = 'action_failed: D1_ERROR: database is locked'
      WHERE id = ?`,
    paid,
  );
  addPayment(harness.raw, { companyId: company }); // звичайний розрахований платіж: у списку його немає
});

async function render(query: Record<string, string> = {}): Promise<string> {
  return renderToStaticMarkup(await AdminPaymentsPage({ searchParams: Promise.resolve(query) }));
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

async function redirectOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof RedirectCalled) return e.url;
    throw e;
  }
  throw new Error("expected a redirect");
}

describe("/admin/payments", () => {
  it("is not found for someone who is not an admin, or for an admin who came through Telegram", async () => {
    await createSession("ada", "email");
    await expect(render()).rejects.toBeInstanceOf(NotFoundCalled);
    await createSession("boss", "telegram");
    await expect(render()).rejects.toBeInstanceOf(NotFoundCalled);
  });

  it("lists payments that settled without a result with company, amount, network, tx, action, reason and time", async () => {
    await createSession("boss", "email");
    const html = await render();
    expect(html).toContain("Paid without result (1 waiting)");
    const row = html.slice(html.indexOf(`data-payment="${paid}"`), html.indexOf("</tr>", html.indexOf(`data-payment="${paid}"`)));
    expect(row).toContain("Acme Labs");
    expect(row).toContain("Intro request");
    expect(row).toContain("$5.00");
    expect(row).toContain("Base Sepolia");
    expect(row).toContain("https://sepolia.basescan.org/tx/0xabc123");
    expect(row).toContain("action_failed: D1_ERROR: database is locked");
    expect(row).toContain("Sep 13, 10:00 UTC");
    expect(row).toContain("Mark refunded");
    expect(html.match(/data-payment=/g)).toHaveLength(1);
    expect(html).toContain('href="/admin/payments"');
  });

  it("marks a payment refunded with a note, writes the audit log once and shows it as refunded", async () => {
    await createSession("boss", "email");
    expect(await redirectOf(markRefundedAction(form({ payment_id: paid, note: "Sent 5 USDC back, tx 0xdef" })))).toBe(
      `/admin/payments?done=refunded&payment=${paid}`,
    );
    expect(rows("SELECT refunded_by, refund_note FROM x402_payments WHERE id = ?", paid)).toEqual([
      { refunded_by: "boss", refund_note: "Sent 5 USDC back, tx 0xdef" },
    ]);
    const audit = rows<{ actor: string; action: string; meta_json: string }>("SELECT actor, action, meta_json FROM audit_log");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ actor: "admin:boss", action: "payment.refund" });
    expect(JSON.parse(audit[0].meta_json)).toMatchObject({ payment_id: paid, company_id: company, amount_usd_cents: 500 });
    expect(audit[0].meta_json).not.toContain("Sent 5 USDC");

    // Вдруге той самий платіж не позначиться і журнал не подвоїться.
    expect(await redirectOf(markRefundedAction(form({ payment_id: paid, note: "again" })))).toContain("error=not_found");
    expect(rows("SELECT id FROM audit_log")).toHaveLength(1);
    const html = await render({ done: "refunded", payment: paid });
    expect(html).toContain("is marked refunded");
    expect(html).toContain("Refunded Sep");
    expect(html).toContain("(0 waiting)");
  });

  it("refuses a refund without a note, and refuses anyone who is not an admin", async () => {
    await createSession("boss", "email");
    expect(await redirectOf(markRefundedAction(form({ payment_id: paid, note: "  " })))).toContain("error=note_required");
    await createSession("ada", "email");
    expect(await redirectOf(markRefundedAction(form({ payment_id: paid, note: "refunded" })))).toBe("/admin/payments?error=not_admin");
    expect(rows("SELECT refunded_at FROM x402_payments WHERE id = ?", paid)).toEqual([{ refunded_at: null }]);
    expect(await markRefunded(harness.env.DB, { paymentId: "pay_nope", adminUserId: "boss", note: "x" })).toEqual({
      ok: false,
      reason: "not_found",
    });
  });
});
