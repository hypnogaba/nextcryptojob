import { beforeEach, describe, expect, it } from "vitest";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import { exportUserData } from "./export";

let t: TestDb;

const SESSION_ID = "5e55".repeat(16);
const CODE_HASH = "c0de".repeat(16);
const VERIFY_CODE = "ncj-q7x9k2";

beforeEach(() => {
  t = migratedD1();
  t.raw.exec(`
    INSERT INTO users (id, email, roles, timezone) VALUES ('a', 'a@example.com', '["engineer"]', 'Europe/Paris');
    INSERT INTO users (id, email) VALUES ('b', 'b@example.com');
    INSERT INTO sessions (id, user_id, expires_at) VALUES ('${SESSION_ID}', 'a', datetime('now', '+1 day'));
    INSERT INTO login_codes (email, code_hash, expires_at) VALUES ('a@example.com', '${CODE_HASH}', datetime('now', '+10 minutes'));
    INSERT INTO identities (user_id, kind, value, verify_code) VALUES ('a', 'github', 'ada', '${VERIFY_CODE}');
    INSERT INTO identities (user_id, kind, value) VALUES ('b', 'x', 'bob');
    INSERT INTO source_facts (user_id, source, facts_json) VALUES ('a', 'github', '{"stars": 12}');
    INSERT INTO scores (user_id, role, score, breakdown_json, formula_version) VALUES ('a', 'engineer', 55, '{"formula":"v5"}', 'v5');
    INSERT INTO cards (slug, user_id, role, score, level, display_name, formula_version) VALUES ('abcdefghij', 'a', 'engineer', 55, 6, 'ada', 'v5');
    INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('a', 'scoring', 1, 'v1');
    INSERT INTO consent_events (user_id, kind, granted, text_version) VALUES ('a', 'scoring', 1, 'v1');
  `);
});

describe("exportUserData", () => {
  it("includes the user row and every listed table", async () => {
    const data = await exportUserData(t.d1, "a");
    expect(Object.keys(data!).sort()).toEqual(
      ["cards", "consent_events", "consents", "exported_at", "format", "identities", "scores", "source_facts", "user"].sort(),
    );
    expect(data!.user).toMatchObject({ id: "a", email: "a@example.com", roles: ["engineer"], timezone: "Europe/Paris" });
    expect(data!.user).toHaveProperty("digest_paused", 0);
    expect(data!.identities).toEqual([
      expect.objectContaining({ kind: "github", value: "ada" }),
    ]);
    expect(data!.source_facts).toEqual([expect.objectContaining({ source: "github", facts_json: { stars: 12 } })]);
    expect(data!.scores).toEqual([expect.objectContaining({ role: "engineer", score: 55, breakdown_json: { formula: "v5" } })]);
    expect(data!.cards).toEqual([expect.objectContaining({ slug: "abcdefghij", level: 6 })]);
    expect(data!.consents).toEqual([expect.objectContaining({ kind: "scoring", granted: 1 })]);
    expect(data!.consent_events).toEqual([expect.objectContaining({ kind: "scoring", granted: 1 })]);
  });

  it("contains no secrets: no session ids, code hashes or verify codes", async () => {
    const json = JSON.stringify(await exportUserData(t.d1, "a"));
    expect(json).not.toContain(SESSION_ID);
    expect(json).not.toContain(CODE_HASH);
    expect(json).not.toContain(VERIFY_CODE);
    expect(json).not.toMatch(/code_hash|verify_code|session/i);
    expect(json).not.toMatch(/\b[0-9a-f]{64}\b/);
  });

  it("holds only this person's data", async () => {
    const json = JSON.stringify(await exportUserData(t.d1, "a"));
    expect(json).not.toContain("bob");
    expect(json).not.toContain("b@example.com");
  });

  it("is null for an unknown person", async () => {
    await expect(exportUserData(t.d1, "nobody")).resolves.toBeNull();
  });
});
