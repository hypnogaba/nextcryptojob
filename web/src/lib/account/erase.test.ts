import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ALL_MIGRATIONS } from "@/test/crm-fixtures";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import { eraseAccount } from "./erase";

const hooks = vi.hoisted(() => ({
  notifyCrmErasure: vi.fn(async (_userId: string) => {}),
  crmErasureBlock: vi.fn(async (_userId: string): Promise<string | null> => null),
  notifyCrmVisibility: vi.fn(async () => {}),
}));
vi.mock("./hooks", () => hooks);

type Ref = { table: string; column: string; onDelete: string };

/** Кожен зовнішній ключ на users(id) у схемі: таблиця, колонка, дія при видаленні. */
function userRefs(raw: DatabaseSync): Ref[] {
  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return tables.flatMap(({ name }) =>
    (raw.prepare("SELECT * FROM pragma_foreign_key_list(?)").all(name) as { table: string; from: string; on_delete: string }[])
      .filter((fk) => fk.table === "users")
      .map((fk) => ({ table: name, column: fk.from, onDelete: fk.on_delete })),
  );
}

/** Таблиці, де є колонка user_id (незалежно від того, чи є на ній ключ). */
function tablesWithUserId(raw: DatabaseSync): string[] {
  const tables = raw
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  return tables
    .filter(({ name }) => (raw.prepare("SELECT name FROM pragma_table_info(?)").all(name) as { name: string }[]).some((c) => c.name === "user_id"))
    .map((t) => t.name);
}

let t: TestDb;
const count = (sql: string, ...p: string[]) => (t.raw.prepare(sql).get(...p) as { n: number }).n;

function seed(raw: DatabaseSync) {
  raw.exec(`
    INSERT INTO users (id, email) VALUES ('a', 'a@example.com'), ('b', 'b@example.com');
    INSERT INTO identities (user_id, kind, value) VALUES ('a', 'github', 'ada'), ('b', 'github', 'bob');
    INSERT INTO source_facts (user_id, source, facts_json) VALUES ('a', 'github', '{}'), ('b', 'github', '{}');
    INSERT INTO scores (user_id, role, score, breakdown_json, formula_version) VALUES
      ('a', 'engineer', 50, '{}', 'v5'), ('b', 'engineer', 40, '{}', 'v5');
    INSERT INTO score_jobs (user_id, reason) VALUES ('a', 'connect'), ('b', 'connect');
    INSERT INTO sessions (id, user_id, expires_at) VALUES ('s-a', 'a', datetime('now', '+1 day')), ('s-b', 'b', datetime('now', '+1 day'));
    INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('a', 'scoring', 1, 'v1'), ('b', 'scoring', 1, 'v1');
    INSERT INTO consent_events (user_id, kind, granted, text_version) VALUES ('a', 'scoring', 1, 'v1'), ('b', 'scoring', 1, 'v1');
    INSERT INTO cards (slug, user_id, role, score, level, display_name, formula_version) VALUES
      ('aaaaaaaaaa', 'a', 'engineer', 50, 6, 'ada', 'v5'), ('bbbbbbbbbb', 'b', 'engineer', 40, 5, 'bob', 'v5');

    INSERT INTO companies (id, name, terms_version, terms_accepted_at, created_by) VALUES ('co_1', 'Acme', 'v1', datetime('now'), 'a');
    INSERT INTO company_members (company_id, user_id, role) VALUES ('co_1', 'a', 'owner'), ('co_1', 'b', 'member');
    INSERT INTO company_jobs (id, company_id, title, created_via, created_by_user_id) VALUES ('job_1', 'co_1', 'Engineer', 'web', 'a');
    INSERT INTO api_keys (id, company_id, name, prefix, key_hash, created_by_user_id) VALUES ('key_1', 'co_1', 'ci', 'ncj_live_x', 'h1', 'a');
    INSERT INTO pipeline (id, company_id, user_id, added_via, added_by_user_id) VALUES (1, 'co_1', 'a', 'web', 'b'), (2, 'co_1', 'b', 'web', 'a');
    INSERT INTO pipeline_events (pipeline_id, company_id, kind, actor_kind, actor_user_id) VALUES
      (1, 'co_1', 'added', 'member', 'b'), (2, 'co_1', 'added', 'member', 'a');
    INSERT INTO intros (id, company_id, user_id, pipeline_id, mode, message, requested_via, requested_by_user_id, expires_at) VALUES
      ('int_1', 'co_1', 'a', 1, 'approval', 'We would like to talk about a role.', 'web', 'b', datetime('now', '+14 days')),
      ('int_2', 'co_1', 'b', 2, 'approval', 'We would like to talk about a role.', 'web', 'a', datetime('now', '+14 days'));

    INSERT INTO login_codes (email, code_hash, expires_at) VALUES
      ('a@example.com', 'x', datetime('now', '+10 minutes')), ('b@example.com', 'y', datetime('now', '+10 minutes'));
    INSERT INTO auth_attempts (key, attempts, window_start) VALUES
      ('code:email:a@example.com', 1, datetime('now')), ('code:email:day:a@example.com', 1, datetime('now')),
      ('verify:email:a@example.com', 1, datetime('now')), ('identity:a', 1, datetime('now')),
      ('card:a', 1, datetime('now')), ('verify:github:a', 1, datetime('now')), ('settings:a', 1, datetime('now')),
      ('code:email:b@example.com', 1, datetime('now')), ('identity:b', 1, datetime('now')), ('card:ba', 1, datetime('now'));
  `);
}

beforeEach(() => {
  t = migratedD1(ALL_MIGRATIONS);
  seed(t.raw);
  hooks.notifyCrmErasure.mockClear();
  hooks.crmErasureBlock.mockClear();
  hooks.crmErasureBlock.mockResolvedValue(null);
});

describe("schema: deleting a user row never fails and never leaves their rows behind", () => {
  it("every user_id column is a key on users with ON DELETE CASCADE", () => {
    const refs = userRefs(t.raw);
    const withUserId = tablesWithUserId(t.raw);
    const missing = withUserId.filter((table) => !refs.some((r) => r.table === table && r.column === "user_id"));
    const notCascade = refs.filter((r) => r.column === "user_id" && r.onDelete !== "CASCADE");
    expect({ missing, notCascade }).toEqual({ missing: [], notCascade: [] });
  });

  it("other references to users (actors, creators) cascade or become NULL, none blocks the delete", () => {
    const blocking = userRefs(t.raw).filter((r) => r.onDelete !== "CASCADE" && r.onDelete !== "SET NULL");
    expect(blocking).toEqual([]);
  });
});

describe("eraseAccount", () => {
  it("deletes every row with this user_id in every table, and only theirs", async () => {
    const tables = [...new Set(userRefs(t.raw).filter((r) => r.column === "user_id").map((r) => r.table))];
    const before = Object.fromEntries(tables.map((tb) => [tb, count(`SELECT count(*) AS n FROM ${tb} WHERE user_id = 'a'`)]));
    const others = Object.fromEntries(tables.map((tb) => [tb, count(`SELECT count(*) AS n FROM ${tb} WHERE user_id = 'b'`)]));
    // Тест сам себе перевіряє: кожна таблиця з user_id засіяна, інакше «0 після» нічого не доводить.
    expect(Object.entries(before).filter(([, n]) => n === 0)).toEqual([]);

    await expect(eraseAccount(t.d1, "a")).resolves.toEqual({ ok: true });

    const after = Object.fromEntries(tables.map((tb) => [tb, count(`SELECT count(*) AS n FROM ${tb} WHERE user_id = 'a'`)]));
    expect(after).toEqual(Object.fromEntries(tables.map((tb) => [tb, 0])));
    // pipeline 2 і int_2 належать людині b: лишаються (intros.user_id = b).
    expect(Object.fromEntries(tables.map((tb) => [tb, count(`SELECT count(*) AS n FROM ${tb} WHERE user_id = 'b'`)]))).toEqual(
      others,
    );
    expect(count("SELECT count(*) AS n FROM users WHERE id = 'a'")).toBe(0);
  });

  it("keeps the company and the other person's rows, clearing only the actor columns", async () => {
    await eraseAccount(t.d1, "a");
    expect(t.raw.prepare("SELECT created_by FROM companies").all().map((r) => ({ ...r }))).toEqual([{ created_by: null }]);
    expect(t.raw.prepare("SELECT created_by_user_id AS c FROM company_jobs").get()).toMatchObject({ c: null });
    expect(t.raw.prepare("SELECT added_by_user_id AS c FROM pipeline WHERE id = 2").get()).toMatchObject({ c: null });
    expect(t.raw.prepare("SELECT requested_by_user_id AS c FROM intros WHERE id = 'int_2'").get()).toMatchObject({ c: null });
    // Історія картки 1 (про a) зникла разом з карткою.
    expect(count("SELECT count(*) AS n FROM pipeline_events WHERE pipeline_id = 1")).toBe(0);
    expect(count("SELECT count(*) AS n FROM pipeline_events WHERE pipeline_id = 2")).toBe(1);
  });

  it("removes sign-in codes and rate-limit counters of this person only", async () => {
    await eraseAccount(t.d1, "a");
    expect(t.raw.prepare("SELECT email FROM login_codes").all().map((r) => ({ ...r }))).toEqual([{ email: "b@example.com" }]);
    expect(
      t.raw
        .prepare("SELECT key FROM auth_attempts ORDER BY key")
        .all()
        .map((r) => r.key),
    ).toEqual(["card:ba", "code:email:b@example.com", "identity:b"]);
  });

  it("records the deletion in the audit log with ids only", async () => {
    await eraseAccount(t.d1, "a");
    expect(t.raw.prepare("SELECT actor, action, target, meta_json FROM audit_log").all().map((r) => ({ ...r }))).toEqual([
      { actor: "a", action: "account.delete", target: "a", meta_json: null },
    ]);
  });

  it("tells the CRM before the rows are gone", async () => {
    hooks.notifyCrmErasure.mockImplementationOnce(async (userId: string) => {
      expect(count("SELECT count(*) AS n FROM intros WHERE user_id = ?", userId)).toBe(1);
    });
    await eraseAccount(t.d1, "a");
    expect(hooks.notifyCrmErasure).toHaveBeenCalledWith("a");
  });

  it("deletes nothing when the CRM hook fails or blocks", async () => {
    hooks.notifyCrmErasure.mockRejectedValueOnce(new Error("mail down"));
    await expect(eraseAccount(t.d1, "a")).rejects.toThrow("mail down");
    expect(count("SELECT count(*) AS n FROM users WHERE id = 'a'")).toBe(1);

    hooks.crmErasureBlock.mockResolvedValueOnce("Hand over your company first.");
    await expect(eraseAccount(t.d1, "a")).resolves.toEqual({
      ok: false,
      reason: "blocked",
      message: "Hand over your company first.",
    });
    expect(count("SELECT count(*) AS n FROM sessions WHERE user_id = 'a'")).toBe(1);
  });

  it("reports an unknown person", async () => {
    await expect(eraseAccount(t.d1, "nobody")).resolves.toEqual({ ok: false, reason: "no_user" });
  });
});
