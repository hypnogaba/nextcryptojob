import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCard } from "@/lib/card/store";
import { exec, harness, resetHarness, rows } from "@/test/harness";
import { reportCardAction } from "./actions";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.set(k, v);
  return data;
}

let slug = "";
beforeEach(async () => {
  resetHarness();
  harness.headers = new Headers({ "cf-connecting-ip": "203.0.113.5" });
  exec("INSERT INTO users (id, email) VALUES ('u', 'u@example.com')");
  slug = await createCard(harness.env.DB, { userId: "u", role: "bd", score: 44, displayName: "@ada", formulaVersion: "v6" });
});

describe("Report this card (trust model of 13.09)", () => {
  it("records the report with the reason key only, no text and no reporter", async () => {
    await expect(reportCardAction({}, form({ slug, reason: "not_theirs" }))).resolves.toMatchObject({ message: { tone: "success" } });
    expect(rows("SELECT actor, action, target, meta_json FROM audit_log WHERE action = 'card.report'")).toEqual([
      { actor: null, action: "card.report", target: slug, meta_json: '{"reason":"not_theirs"}' },
    ]);
  });

  it("refuses an unknown reason and a card that does not exist", async () => {
    await expect(reportCardAction({}, form({ slug, reason: "because" }))).resolves.toMatchObject({ message: { text: "Pick a reason." } });
    await expect(reportCardAction({}, form({ slug: "AAAAAAAAAA", reason: "fake" }))).resolves.toMatchObject({
      message: { text: "This card no longer exists." },
    });
    expect(rows("SELECT * FROM audit_log WHERE action = 'card.report'")).toEqual([]);
  });

  it("allows five reports an hour from one address", async () => {
    for (let i = 0; i < 5; i++) await reportCardAction({}, form({ slug, reason: "other" }));
    await expect(reportCardAction({}, form({ slug, reason: "other" }))).resolves.toMatchObject({
      message: { tone: "error", text: expect.stringMatching(/Too many reports/) },
    });
    expect(rows("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'card.report'")).toEqual([{ n: 5 }]);
  });
});
