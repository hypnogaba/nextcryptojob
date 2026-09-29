import { beforeEach, describe, expect, it } from "vitest";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import { exportUserData } from "./export";

let t: TestDb;

const SESSION_ID = "5e55".repeat(16);
const CODE_HASH = "c0de".repeat(16);
const VERIFY_CODE = "ncj-q7x9k2";
const RESPOND_TOKEN_HASH = "7a11".repeat(16);

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
    UPDATE users SET role_text = 'I audit DeFi lending', card_public = 0, telegram_unreachable_at = '2026-09-20 09:00:00' WHERE id = 'a';
    INSERT INTO profile_prefs (user_id, key_version, hidden_json, links_json, show_wallet)
      VALUES ('a', 3, '["github.stars"]', '[{"label":"Audit","url":"https://example.com/audit"}]', 1);
    INSERT INTO saved_jobs (user_id, job_ref) VALUES ('a', 'nr:7'), ('b', 'nr:8');
    INSERT INTO digest_runs (id, user_id, local_date, status, jobs, channel) VALUES ('dg_a', 'a', '2026-09-12', 'sent', 1, 'telegram'), ('dg_b', 'b', '2026-09-12', 'sent', 1, 'email');
    INSERT INTO sent (user_id, job_ref, source, digest_id, position, status, channel, why) VALUES
      ('a', 'nr:1', 'nextrole', 'dg_a', 1, 'sent', 'telegram', 'Matches your Solidity work'), ('b', 'nr:9', 'nextrole', 'dg_b', 1, 'sent', 'email', NULL);
    INSERT INTO companies (id, name, terms_version, terms_accepted_at, created_by) VALUES ('co_1', 'Acme Labs', 'v1', datetime('now'), 'b');
    INSERT INTO intros (id, company_id, user_id, mode, status, message, requested_via, respond_token_hash, contact_kind, contact_value, expires_at) VALUES
      ('int_1', 'co_1', 'a', 'approval', 'accepted', 'We would like to talk about a role.', 'web', '${RESPOND_TOKEN_HASH}', 'email', 'a@example.com', datetime('now', '+14 days')),
      ('int_2', 'co_1', 'b', 'approval', 'pending', 'A message meant for bob only.', 'web', NULL, NULL, NULL, datetime('now', '+14 days'));
    INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('a', 'scoring', 1, 'v1');
    INSERT INTO consent_events (user_id, kind, granted, text_version) VALUES ('a', 'scoring', 1, 'v1');
  `);
});

describe("exportUserData", () => {
  it("includes the user row and every listed table", async () => {
    const data = await exportUserData(t.d1, "a");
    expect(Object.keys(data!).sort()).toEqual(
      [
        "cards", "consent_events", "consents", "digest_runs", "exported_at", "format", "identities", "intros",
        "profile_prefs", "saved_jobs", "scores", "sent", "source_facts", "user",
      ].sort(),
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

  it("has what the person typed and chose: own words, leaderboard flag, Telegram reachability, profile choices", async () => {
    const data = await exportUserData(t.d1, "a");
    expect(data!.user).toMatchObject({ role_text: "I audit DeFi lending", card_public: 0, telegram_unreachable_at: "2026-09-20 09:00:00" });
    expect(data!.profile_prefs).toEqual({
      hidden: ["github.stars"],
      links: [{ label: "Audit", url: "https://example.com/audit" }],
      show_wallet: 1,
      updated_at: expect.any(String),
    });
    expect(data!.saved_jobs).toEqual([expect.objectContaining({ job_ref: "nr:7" })]);
  });

  it("has the jobs we sent and the daily runs, and the intro requests the person received, only their own", async () => {
    const data = await exportUserData(t.d1, "a");
    expect(data!.sent).toEqual([expect.objectContaining({ job_ref: "nr:1", status: "sent", why: "Matches your Solidity work" })]);
    expect(data!.digest_runs).toEqual([expect.objectContaining({ id: "dg_a", local_date: "2026-09-12", jobs: 1 })]);
    expect(data!.intros).toEqual([
      expect.objectContaining({ id: "int_1", company: "Acme Labs", status: "accepted", contact_kind: "email", contact_value: "a@example.com" }),
    ]);
    expect(JSON.stringify(data)).not.toContain("meant for bob only");
  });

  it("does not export the intro response token or the profile key version", async () => {
    const json = JSON.stringify(await exportUserData(t.d1, "a"));
    expect(json).not.toContain(RESPOND_TOKEN_HASH);
    expect(json).not.toMatch(/respond_token|key_version/);
  });

  it("covers every table that holds a person's rows: each is exported or knowingly left out", async () => {
    const tables = (t.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[])
      .map((r) => r.name);
    const withUser = tables.filter((name) =>
      (t.raw.prepare(`PRAGMA table_info(${name})`).all() as { name: string }[]).some((c) => c.name === "user_id"),
    );
    // Вивантажується (export.ts) або свідомо ні: секрети входу, службові й чужі дані про людину.
    const EXPORTED = [
      "identities", "source_facts", "scores", "cards", "consents", "consent_events", "profile_prefs", "saved_jobs", "sent",
      "digest_runs", "intros",
    ];
    const LEFT_OUT = [
      "sessions", "score_jobs", "pipeline", "pipeline_events", "company_members", "testimonials", "feedback", "job_clicks",
      "audit_log",
    ];
    const unexplained = withUser.filter((n) => !EXPORTED.includes(n) && !LEFT_OUT.includes(n));
    expect(unexplained).toEqual([]);
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
