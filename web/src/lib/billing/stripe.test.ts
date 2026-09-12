import { describe, expect, it } from "vitest";
import { stripeClient, stripeSettings } from "./stripe";

const ALL = { STRIPE_SECRET_KEY: "sk_test_x", STRIPE_PRICE_ID: "price_x", STRIPE_WEBHOOK_SECRET: "whsec_x" };

describe("stripeSettings", () => {
  it("is on only with the key, the price and the webhook secret", () => {
    expect(stripeSettings(ALL)).toEqual({ enabled: true, secretKey: "sk_test_x", priceId: "price_x", webhookSecret: "whsec_x" });
  });

  it("stays off without the webhook secret: a paid subscription would never reach the database", () => {
    expect(stripeSettings({ ...ALL, STRIPE_WEBHOOK_SECRET: " " })).toEqual({
      enabled: false,
      reason: "not configured: STRIPE_WEBHOOK_SECRET",
      missing: ["STRIPE_WEBHOOK_SECRET"],
    });
  });

  it("names everything that is missing", () => {
    expect(stripeSettings({})).toMatchObject({
      enabled: false,
      reason: "not configured: STRIPE_SECRET_KEY, STRIPE_PRICE_ID, STRIPE_WEBHOOK_SECRET",
    });
  });
});

describe("stripeClient", () => {
  it("is null without a secret key", () => {
    expect(stripeClient({})).toBeNull();
    expect(stripeClient({ STRIPE_SECRET_KEY: "sk_test_x" })).not.toBeNull();
  });
});
