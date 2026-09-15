import { beforeEach, describe, expect, it, vi } from "vitest";
import { crmDb } from "@/test/crm-fixtures";
import { harness, resetHarness, rows } from "@/test/harness";
import { submitContactAction } from "./actions";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

/** /contact (A): honeypot, обмеження частоти за IP, і сповіщення власнику при успіху. */

function setup() {
  resetHarness();
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
  harness.headers = new Headers({ "cf-connecting-ip": "203.0.113.7" });
}

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

const VALID = { email: "ada@example.com", topic: "candidate", message: "I would like to know more about the score.", website: "" };

beforeEach(() => setup());

describe("submitContactAction", () => {
  it("writes a message and sends an owner alert on success", async () => {
    const res = await submitContactAction({}, form(VALID));
    expect(res.message).toMatchObject({ tone: "success" });
    expect(rows("SELECT email, topic FROM contact_messages")).toEqual([{ email: "ada@example.com", topic: "candidate" }]);
    expect(rows("SELECT key FROM owner_alerts WHERE key LIKE 'contact:%'")).toHaveLength(1);
  });

  it("honeypot filled: still says success, but writes nothing and does not spend the rate limit", async () => {
    const res = await submitContactAction({}, form({ ...VALID, website: "http://spam.example" }));
    expect(res.message?.tone).toBe("success");
    expect(rows("SELECT * FROM contact_messages")).toHaveLength(0);
    expect(rows("SELECT * FROM auth_attempts")).toHaveLength(0);
  });

  it("rejects an invalid email without writing a row", async () => {
    const res = await submitContactAction({}, form({ ...VALID, email: "not-an-email" }));
    expect(res.message?.tone).toBe("error");
    expect(rows("SELECT * FROM contact_messages")).toHaveLength(0);
  });

  it("blocks after too many messages from the same IP within an hour", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await submitContactAction({}, form({ ...VALID, message: `Message number ${i} with enough length.` }));
      expect(res.message?.tone).toBe("success");
    }
    const blocked = await submitContactAction({}, form(VALID));
    expect(blocked.message?.tone).toBe("error");
    expect(blocked.message?.text).toContain("Too many messages");
    expect(rows("SELECT * FROM contact_messages")).toHaveLength(5);
  });
});
