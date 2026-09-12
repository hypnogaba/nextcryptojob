import { describe, expect, it, vi } from "vitest";
import { event, signed, WEBHOOK_SECRET, webhookRequest } from "@/lib/billing/stripe-fixtures";
import type { AppEnv } from "@/lib/db";
import { resetHarness } from "@/test/harness";
import { POST } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);

const KEYS = { STRIPE_SECRET_KEY: "sk_test_fake", STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET } as unknown as Partial<AppEnv>;

describe("POST /api/stripe/webhook", () => {
  it("answers 503 without Stripe keys", async () => {
    resetHarness();
    const { body, signature } = await signed(event("charge.succeeded", {}));
    expect((await POST(webhookRequest(body, signature))).status).toBe(503);
  });

  it("answers 400 to a forged signature", async () => {
    resetHarness(KEYS);
    const { body, signature } = await signed(event("customer.subscription.updated", { id: "sub_x" }), { secret: "whsec_forged" });
    expect((await POST(webhookRequest(body, signature))).status).toBe(400);
  });

  it("answers 200 to a signed event it does not need", async () => {
    resetHarness(KEYS);
    const { body, signature } = await signed(event("charge.succeeded", { id: "ch_1" }));
    const res = await POST(webhookRequest(body, signature));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ received: true, outcome: "ignored" });
  });
});
