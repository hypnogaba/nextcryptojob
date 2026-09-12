import { beforeEach, describe, expect, it } from "vitest";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import { grantConsent, hasConsent, SCORING_CONSENT } from "./consent";

let t: TestDb;
const all = (sql: string) => t.raw.prepare(sql).all().map((r) => ({ ...r }));

beforeEach(() => {
  t = migratedD1();
  t.raw.exec("INSERT INTO users (id, email) VALUES ('a', 'a@example.com')");
});

describe("grantConsent", () => {
  it("writes the current state and the history in one go", async () => {
    await expect(grantConsent(t.d1, "a", "scoring", "v1")).resolves.toBe(true);
    expect(all("SELECT user_id, kind, granted, text_version FROM consents")).toEqual([
      { user_id: "a", kind: "scoring", granted: 1, text_version: "v1" },
    ]);
    expect(all("SELECT user_id, kind, granted, text_version FROM consent_events")).toEqual([
      { user_id: "a", kind: "scoring", granted: 1, text_version: "v1" },
    ]);
    const [{ at }] = all("SELECT at FROM consents") as { at: string }[];
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    await expect(hasConsent(t.d1, "a", "scoring")).resolves.toBe(true);
  });

  it("does not add history when the same version is given again", async () => {
    await grantConsent(t.d1, "a", "scoring", "v1");
    await expect(grantConsent(t.d1, "a", "scoring", "v1")).resolves.toBe(false);
    expect(all("SELECT id FROM consent_events")).toHaveLength(1);
  });

  it("records a new version as a new event", async () => {
    await grantConsent(t.d1, "a", "scoring", "v1");
    await grantConsent(t.d1, "a", "scoring", "v2");
    expect(all("SELECT text_version FROM consent_events ORDER BY id")).toEqual([
      { text_version: "v1" },
      { text_version: "v2" },
    ]);
    expect(all("SELECT text_version FROM consents")).toEqual([{ text_version: "v2" }]);
  });

  it("writes neither table when one write fails", async () => {
    t.raw.exec("DROP TABLE consent_events");
    await expect(grantConsent(t.d1, "a", "scoring", "v1")).rejects.toThrow();
    expect(all("SELECT * FROM consents")).toEqual([]);
  });

  it("uses the product wording for the scoring consent", () => {
    expect(SCORING_CONSENT).toEqual({
      kind: "scoring",
      version: "v1",
      text: "I agree that NextCryptoJob computes my score from the public data I connected.",
    });
  });
});

describe("hasConsent", () => {
  it("is false without a row or after withdrawal", async () => {
    await expect(hasConsent(t.d1, "a", "scoring")).resolves.toBe(false);
    t.raw.exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('a', 'scoring', 0, 'v1')");
    await expect(hasConsent(t.d1, "a", "scoring")).resolves.toBe(false);
  });
});
