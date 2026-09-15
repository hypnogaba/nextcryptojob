import { beforeEach, describe, expect, it } from "vitest";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import { checkMergeGrant, MERGE_GRANT_MINUTES, MERGE_REFS, mergeAccounts, mergeGrant } from "./merge";

/** Мінімальні рядки для тестів: лише колонки, важливі для конкретного випадку. */
function insertUser(t: TestDb, id: string, fields: Record<string, string | number | null> = {}) {
  const cols = ["id", ...Object.keys(fields)];
  const values = [id, ...Object.values(fields)];
  const placeholders = cols.map(() => "?").join(", ");
  t.raw.prepare(`INSERT INTO users (${cols.join(", ")}) VALUES (${placeholders})`).run(...values);
}

function exec(t: TestDb, sql: string, ...params: (string | number | null)[]) {
  t.raw.prepare(sql).run(...params);
}

function one<T = Record<string, unknown>>(t: TestDb, sql: string, ...params: (string | number | null)[]): T {
  return t.raw.prepare(sql).get(...params) as T;
}

function all<T = Record<string, unknown>>(t: TestDb, sql: string, ...params: (string | number | null)[]): T[] {
  return t.raw.prepare(sql).all(...params) as T[];
}

let t: TestDb;

beforeEach(() => {
  t = migratedD1();
});

describe("mergeAccounts: refuses to merge", () => {
  it("refuses the same profile with itself", async () => {
    await expect(mergeAccounts(t.d1, "a", "a")).resolves.toEqual({ ok: false, reason: "same_user" });
  });

  it("refuses when a profile does not exist", async () => {
    insertUser(t, "a");
    await expect(mergeAccounts(t.d1, "a", "ghost")).resolves.toEqual({ ok: false, reason: "no_user" });
    await expect(mergeAccounts(t.d1, "ghost", "a")).resolves.toEqual({ ok: false, reason: "no_user" });
  });

  it("refuses two profiles with different Telegram accounts connected", async () => {
    insertUser(t, "survivor", { telegram_id: "111", channel: "telegram" });
    insertUser(t, "other", { email: "ada@example.com", telegram_id: "222", channel: "telegram" });
    await expect(mergeAccounts(t.d1, "survivor", "other")).resolves.toEqual({ ok: false, reason: "conflict" });
    // Нічого не змінилось.
    expect(all(t, "SELECT id FROM users")).toHaveLength(2);
  });

  it("does not treat two different emails as a conflict when one side has none", async () => {
    // Емейл лише в одного профілю ніколи не конфліктує (порожнє поле не суперечить).
    insertUser(t, "survivor", { telegram_id: "111", channel: "telegram" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email" });
    const res = await mergeAccounts(t.d1, "survivor", "other");
    expect(res.ok).toBe(true);
  });
});

describe("mergeAccounts: users row", () => {
  it("moves email and telegram onto the survivor and deletes the other row", async () => {
    insertUser(t, "survivor", { telegram_id: "555", telegram_username: "ivan", channel: "telegram" });
    insertUser(t, "other", { email: "Ada@Example.com", channel: "email" });

    const res = await mergeAccounts(t.d1, "survivor", "other");
    expect(res).toEqual({ ok: true, survivor: "survivor", merged: "other", profileFrom: "survivor" });

    expect(all(t, "SELECT id FROM users")).toEqual([{ id: "survivor" }]);
    const row = one<{ email: string; telegram_id: string }>(t, "SELECT email, telegram_id FROM users WHERE id = 'survivor'");
    expect(row).toEqual({ email: "ada@example.com", telegram_id: "555" });
  });

  it("keeps the survivor's own email or telegram id when it already has one", async () => {
    insertUser(t, "survivor", { email: "keep@example.com", channel: "email" });
    insertUser(t, "other", { telegram_id: "999", telegram_username: "otherbot", channel: "telegram" });

    await mergeAccounts(t.d1, "survivor", "other");
    const row = one<{ email: string; telegram_id: string }>(t, "SELECT email, telegram_id FROM users WHERE id = 'survivor'");
    expect(row).toEqual({ email: "keep@example.com", telegram_id: "999" });
  });

  it("takes the questionnaire from whichever profile went further, and keeps the survivor's on a tie", async () => {
    // "other" пройшов далі (onboarding_step = 'sources'), його роль і місто перемагають.
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram", onboarding_step: "target", roles: "[]", city: null });
    insertUser(t, "other", {
      email: "ada@example.com",
      channel: "email",
      onboarding_step: "sources",
      roles: '["engineer"]',
      city: "Berlin",
    });

    await mergeAccounts(t.d1, "survivor", "other");
    const row = one<{ roles: string; city: string; onboarding_step: string }>(
      t,
      "SELECT roles, city, onboarding_step FROM users WHERE id = 'survivor'",
    );
    expect(row).toEqual({ roles: '["engineer"]', city: "Berlin", onboarding_step: "sources" });
  });

  it("keeps the survivor's questionnaire on a tie of onboarding steps", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram", onboarding_step: "roles", city: "Paris" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email", onboarding_step: "roles", city: "Lisbon" });

    await mergeAccounts(t.d1, "survivor", "other");
    const row = one<{ city: string }>(t, "SELECT city FROM users WHERE id = 'survivor'");
    expect(row.city).toBe("Paris");
  });

  it("keeps the earliest created_at and the latest last_active_at", async () => {
    insertUser(t, "survivor", {
      telegram_id: "1",
      channel: "telegram",
      created_at: "2026-05-01 00:00:00",
      last_active_at: "2026-09-01 00:00:00",
    });
    insertUser(t, "other", {
      email: "ada@example.com",
      channel: "email",
      created_at: "2026-01-01 00:00:00",
      last_active_at: "2026-09-10 00:00:00",
    });

    await mergeAccounts(t.d1, "survivor", "other");
    const row = one<{ created_at: string; last_active_at: string }>(
      t,
      "SELECT created_at, last_active_at FROM users WHERE id = 'survivor'",
    );
    expect(row).toEqual({ created_at: "2026-01-01 00:00:00", last_active_at: "2026-09-10 00:00:00" });
  });
});

describe("mergeAccounts: identities", () => {
  it("keeps the survivor's single-per-kind identity and fills in what it is missing", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email" });
    exec(t, "INSERT INTO identities (user_id, kind, value) VALUES ('survivor', 'x', 'survivorx')");
    exec(t, "INSERT INTO identities (user_id, kind, value) VALUES ('other', 'x', 'otherx')");
    exec(t, "INSERT INTO identities (user_id, kind, value) VALUES ('other', 'github', 'otherhub')");

    await mergeAccounts(t.d1, "survivor", "other");
    const kinds = all<{ kind: string; value: string }>(t, "SELECT kind, value FROM identities WHERE user_id = 'survivor' ORDER BY kind");
    expect(kinds).toEqual([
      { kind: "github", value: "otherhub" },
      { kind: "x", value: "survivorx" },
    ]);
  });

  it("prefers the profile that went further for single-per-kind identities", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram", onboarding_step: "target" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email", onboarding_step: "sources" });
    exec(t, "INSERT INTO identities (user_id, kind, value) VALUES ('survivor', 'x', 'survivorx')");
    exec(t, "INSERT INTO identities (user_id, kind, value) VALUES ('other', 'x', 'otherx')");

    await mergeAccounts(t.d1, "survivor", "other");
    const x = one<{ value: string }>(t, "SELECT value FROM identities WHERE user_id = 'survivor' AND kind = 'x'");
    expect(x.value).toBe("otherx");
  });

  it("combines wallets from both profiles without duplicates", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email" });
    exec(t, "INSERT INTO identities (user_id, kind, value) VALUES ('survivor', 'evm', '0xaaa')");
    exec(t, "INSERT INTO identities (user_id, kind, value) VALUES ('other', 'evm', '0xaaa')"); // той самий гаманець
    exec(t, "INSERT INTO identities (user_id, kind, value) VALUES ('other', 'solana', 'sol111')");

    await mergeAccounts(t.d1, "survivor", "other");
    const wallets = all<{ kind: string; value: string }>(
      t,
      "SELECT kind, value FROM identities WHERE user_id = 'survivor' ORDER BY kind",
    );
    expect(wallets).toEqual([
      { kind: "evm", value: "0xaaa" },
      { kind: "solana", value: "sol111" },
    ]);
  });
});

describe("mergeAccounts: source facts, scores, consents", () => {
  it("keeps the survivor's source facts and score for a role both have, and adds what only the other has", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email" });
    exec(t, "INSERT INTO source_facts (user_id, source, facts_json) VALUES ('survivor', 'x', '{\"a\":1}')");
    exec(t, "INSERT INTO source_facts (user_id, source, facts_json) VALUES ('other', 'x', '{\"a\":2}')");
    exec(t, "INSERT INTO source_facts (user_id, source, facts_json) VALUES ('other', 'github', '{\"b\":1}')");
    exec(t, "INSERT INTO scores (user_id, role, score, breakdown_json, formula_version) VALUES ('other', 'engineer', 70, '{}', 'v6')");

    await mergeAccounts(t.d1, "survivor", "other");
    const facts = all<{ source: string; facts_json: string }>(t, "SELECT source, facts_json FROM source_facts WHERE user_id = 'survivor' ORDER BY source");
    expect(facts).toEqual([
      { source: "github", facts_json: '{"b":1}' },
      { source: "x", facts_json: '{"a":1}' },
    ]);
    const score = one<{ score: number }>(t, "SELECT score FROM scores WHERE user_id = 'survivor' AND role = 'engineer'");
    expect(score.score).toBe(70);
  });

  it("keeps the survivor's consent for a kind both have and moves consent events", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email" });
    exec(t, "INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('survivor', 'visibility', 0, 'v1')");
    exec(t, "INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('other', 'visibility', 1, 'v1')");
    exec(t, "INSERT INTO consent_events (user_id, kind, granted, text_version) VALUES ('other', 'visibility', 1, 'v1')");

    await mergeAccounts(t.d1, "survivor", "other");
    const consent = one<{ granted: number }>(t, "SELECT granted FROM consents WHERE user_id = 'survivor' AND kind = 'visibility'");
    expect(consent.granted).toBe(0);
    expect(all(t, "SELECT user_id FROM consent_events")).toEqual([{ user_id: "survivor" }]);
  });
});

describe("mergeAccounts: score queue, cards, sessions", () => {
  it("drops the other profile's queued score jobs and moves the rest", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email" });
    exec(t, "INSERT INTO score_jobs (user_id, reason, status) VALUES ('other', 'connect', 'queued')");
    exec(t, "INSERT INTO score_jobs (user_id, reason, status) VALUES ('other', 'refresh', 'done')");

    await mergeAccounts(t.d1, "survivor", "other");
    const jobs = all<{ user_id: string; status: string }>(t, "SELECT user_id, status FROM score_jobs");
    expect(jobs).toEqual([{ user_id: "survivor", status: "done" }]);
  });

  // Раунд 5, п.7: одна картка на людину (не на людину й роль): якщо обидва профілі мають активну
  // картку, лишається лише winner, other відкликається (той самий власник, тож без redirect_to).
  it("when both have an active card, revokes the other's and keeps the survivor's", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram", onboarding_step: "sources" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email", onboarding_step: "target" });
    exec(
      t,
      "INSERT INTO cards (slug, user_id, role, score, level, display_name, formula_version) VALUES ('s1', 'survivor', 'engineer', 80, 9, 'Ivan', 'v6')",
    );
    exec(
      t,
      "INSERT INTO cards (slug, user_id, role, score, level, display_name, formula_version) VALUES ('s2', 'other', 'trader', 90, 10, 'Ivan', 'v6')",
    );

    await mergeAccounts(t.d1, "survivor", "other");
    const cards = all<{ slug: string; user_id: string; revoked_at: string | null }>(
      t,
      "SELECT slug, user_id, revoked_at FROM cards ORDER BY slug",
    );
    expect(cards.every((c) => c.user_id === "survivor")).toBe(true);
    expect(cards.find((c) => c.slug === "s1")?.revoked_at).toBeNull();
    expect(cards.find((c) => c.slug === "s2")?.revoked_at).not.toBeNull();
  });

  it("when only the other profile has a card, it moves over and stays active", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram", onboarding_step: "sources" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email", onboarding_step: "target" });
    exec(
      t,
      "INSERT INTO cards (slug, user_id, role, score, level, display_name, formula_version) VALUES ('s2', 'other', 'trader', 90, 10, 'Ivan', 'v6')",
    );

    await mergeAccounts(t.d1, "survivor", "other");
    const card = one<{ user_id: string; revoked_at: string | null }>(t, "SELECT user_id, revoked_at FROM cards WHERE slug = 's2'");
    expect(card).toEqual({ user_id: "survivor", revoked_at: null });
  });

  it("moves the other profile's sessions onto the survivor", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email" });
    exec(t, "INSERT INTO sessions (id, user_id, expires_at) VALUES ('sess1', 'other', '2030-01-01 00:00:00')");

    await mergeAccounts(t.d1, "survivor", "other");
    expect(one<{ user_id: string }>(t, "SELECT user_id FROM sessions WHERE id = 'sess1'").user_id).toBe("survivor");
  });

  // Раунд 5, п.16: збережені вакансії обох профілів переходять до survivor; та сама вже збережена
  // в обох лишається одним рядком (PRIMARY KEY(user_id, job_ref) не дублюємо).
  it("moves saved jobs onto the survivor, keeping one row for a job saved by both", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email" });
    exec(t, "INSERT INTO saved_jobs (user_id, job_ref) VALUES ('survivor', 'nr:shared'), ('other', 'nr:shared'), ('other', 'nr:only-other')");

    await mergeAccounts(t.d1, "survivor", "other");
    const refs = all<{ job_ref: string }>(t, "SELECT job_ref FROM saved_jobs ORDER BY job_ref");
    expect(refs).toEqual([{ job_ref: "nr:only-other" }, { job_ref: "nr:shared" }]);
    expect(all<{ user_id: string }>(t, "SELECT user_id FROM saved_jobs").every((r) => r.user_id === "survivor")).toBe(true);
  });
});

describe("mergeAccounts: digests", () => {
  it("adds up the job counts of the same local date and keeps one digest row", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email" });
    exec(t, "INSERT INTO digest_runs (id, user_id, local_date, jobs) VALUES ('dg1', 'survivor', '2026-09-14', 2)");
    exec(t, "INSERT INTO digest_runs (id, user_id, local_date, jobs) VALUES ('dg2', 'other', '2026-09-14', 3)");
    exec(t, "INSERT INTO digest_runs (id, user_id, local_date, jobs) VALUES ('dg3', 'other', '2026-09-13', 1)");

    await mergeAccounts(t.d1, "survivor", "other");
    const runs = all<{ id: string; user_id: string; jobs: number }>(t, "SELECT id, user_id, jobs FROM digest_runs ORDER BY id");
    expect(runs).toEqual([
      { id: "dg1", user_id: "survivor", jobs: 5 },
      { id: "dg3", user_id: "survivor", jobs: 1 },
    ]);
  });

  it("keeps one sent row for the same job sent to both profiles", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email" });
    exec(t, "INSERT INTO digest_runs (id, user_id, local_date) VALUES ('dg1', 'survivor', '2026-09-14')");
    exec(t, "INSERT INTO digest_runs (id, user_id, local_date) VALUES ('dg2', 'other', '2026-09-14')");
    exec(t, "INSERT INTO sent (user_id, job_ref, source, digest_id, position) VALUES ('survivor', 'nr:1', 'nextrole', 'dg1', 1)");
    exec(t, "INSERT INTO sent (user_id, job_ref, source, digest_id, position) VALUES ('other', 'nr:1', 'nextrole', 'dg2', 1)");
    exec(t, "INSERT INTO sent (user_id, job_ref, source, digest_id, position) VALUES ('other', 'nr:2', 'nextrole', 'dg2', 2)");

    await mergeAccounts(t.d1, "survivor", "other");
    const sent = all<{ job_ref: string; user_id: string }>(t, "SELECT job_ref, user_id FROM sent ORDER BY job_ref");
    expect(sent).toEqual([
      { job_ref: "nr:1", user_id: "survivor" },
      { job_ref: "nr:2", user_id: "survivor" },
    ]);
  });
});

describe("mergeAccounts: companies", () => {
  function insertCompany(id: string, createdBy: string | null) {
    exec(
      t,
      `INSERT INTO companies (id, name, terms_version, terms_accepted_at, created_by)
       VALUES (?, 'Acme', 'v1', datetime('now'), ?)`,
      id,
      createdBy,
    );
  }

  it("promotes the other's membership to owner and keeps one row per company", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email" });
    insertCompany("co1", null);
    exec(t, "INSERT INTO company_members (company_id, user_id, role) VALUES ('co1', 'survivor', 'member')");
    exec(t, "INSERT INTO company_members (company_id, user_id, role) VALUES ('co1', 'other', 'owner')");

    await mergeAccounts(t.d1, "survivor", "other");
    const members = all<{ user_id: string; role: string }>(t, "SELECT user_id, role FROM company_members");
    expect(members).toEqual([{ user_id: "survivor", role: "owner" }]);
  });

  it("moves companies.created_by from the other profile to the survivor (MERGE_REFS)", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email" });
    insertCompany("co1", "other");

    await mergeAccounts(t.d1, "survivor", "other");
    expect(one<{ created_by: string }>(t, "SELECT created_by FROM companies WHERE id = 'co1'").created_by).toBe("survivor");
  });
});

describe("mergeAccounts: pipeline and intros", () => {
  function insertCompany(id: string) {
    exec(
      t,
      `INSERT INTO companies (id, name, terms_version, terms_accepted_at) VALUES (?, 'Acme', 'v1', datetime('now'))`,
      id,
    );
  }

  it("merges two pipeline cards of the same company into one, keeping the further stage and combined notes/tags", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email" });
    insertCompany("co1");
    exec(
      t,
      `INSERT INTO pipeline (id, company_id, user_id, stage, note_count, tags, added_via)
       VALUES (1, 'co1', 'survivor', 'found', 1, '["a"]', 'web')`,
    );
    exec(
      t,
      `INSERT INTO pipeline (id, company_id, user_id, stage, note_count, tags, added_via)
       VALUES (2, 'co1', 'other', 'interview', 2, '["b"]', 'web')`,
    );
    exec(t, "INSERT INTO pipeline_events (id, pipeline_id, company_id, kind, actor_kind) VALUES (1, 2, 'co1', 'added', 'system')");

    await mergeAccounts(t.d1, "survivor", "other");
    const cards = all<{ id: number; user_id: string; stage: string; note_count: number; tags: string }>(
      t,
      "SELECT id, user_id, stage, note_count, tags FROM pipeline",
    );
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ id: 1, user_id: "survivor", stage: "interview", note_count: 3 });
    expect(JSON.parse(cards[0].tags).sort()).toEqual(["a", "b"]);
    expect(one<{ pipeline_id: number }>(t, "SELECT pipeline_id FROM pipeline_events WHERE id = 1").pipeline_id).toBe(1);
  });

  it("moves a pipeline card for a company only the other profile has", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email" });
    insertCompany("co1");
    exec(t, `INSERT INTO pipeline (id, company_id, user_id, stage, added_via) VALUES (1, 'co1', 'other', 'found', 'web')`);

    await mergeAccounts(t.d1, "survivor", "other");
    expect(one<{ user_id: string }>(t, "SELECT user_id FROM pipeline WHERE id = 1").user_id).toBe("survivor");
  });

  it("cancels the other's pending intro when the survivor already has an open one with that company", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email" });
    insertCompany("co1");
    exec(
      t,
      `INSERT INTO intros (id, company_id, user_id, mode, status, message, requested_via, expires_at)
       VALUES ('int1', 'co1', 'survivor', 'approval', 'pending', 'Hi there, we would love to talk', 'web', datetime('now', '+14 days'))`,
    );
    exec(
      t,
      `INSERT INTO intros (id, company_id, user_id, mode, status, message, requested_via, expires_at)
       VALUES ('int2', 'co1', 'other', 'approval', 'pending', 'Hi there, we would love to talk', 'web', datetime('now', '+14 days'))`,
    );

    await mergeAccounts(t.d1, "survivor", "other");
    const intros = all<{ id: string; user_id: string; status: string }>(t, "SELECT id, user_id, status FROM intros ORDER BY id");
    expect(intros).toEqual([
      { id: "int1", user_id: "survivor", status: "pending" },
      { id: "int2", user_id: "survivor", status: "canceled" },
    ]);
  });
});

describe("mergeAccounts: bookkeeping", () => {
  it("writes an account.merge audit row and deletes the other user's row", async () => {
    insertUser(t, "survivor", { telegram_id: "1", channel: "telegram" });
    insertUser(t, "other", { email: "ada@example.com", channel: "email" });

    await mergeAccounts(t.d1, "survivor", "other");
    const log = one<{ actor: string; action: string; target: string; meta_json: string }>(
      t,
      "SELECT actor, action, target, meta_json FROM audit_log WHERE action = 'account.merge'",
    );
    expect(log).toMatchObject({ actor: "survivor", action: "account.merge", target: "survivor" });
    expect(JSON.parse(log.meta_json)).toEqual({ merged: "other", profile_from: "survivor" });
    expect(all(t, "SELECT id FROM users WHERE id = 'other'")).toEqual([]);
  });

  it("MERGE_REFS lists every foreign key onto users, matching the live schema", () => {
    const cols = all<{ name: string; type: string; tbl: string }>(
      t,
      `SELECT m.name AS tbl, p."table" AS ref, p."from" AS col
       FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) p ON 1=1
       WHERE m.type = 'table' AND p."table" = 'users'`,
    ) as unknown as { tbl: string; col: string }[];
    const live = new Set(cols.map((c) => `${c.tbl}.${c.col}`));
    // Кожне посилання зі схеми має запис у MERGE_REFS.
    for (const key of live) expect(Object.keys(MERGE_REFS)).toContain(key);
    // MERGE_REFS не згадує таблицю чи колонку, якої вже немає в схемі.
    for (const key of Object.keys(MERGE_REFS)) expect(live).toContain(key);
  });
});

describe("merge grant", () => {
  const SECRET = "test-secret-0123456789abcdef0123456789abcdef";

  it("accepts a grant for the exact pair of profiles and email it was issued for", async () => {
    const grant = await mergeGrant(SECRET, "survivor", "other", "ada@example.com");
    await expect(checkMergeGrant(SECRET, grant, "survivor", "other", "ada@example.com")).resolves.toBe(true);
  });

  it("rejects a grant for a different profile pair, email, or secret", async () => {
    const grant = await mergeGrant(SECRET, "survivor", "other", "ada@example.com");
    await expect(checkMergeGrant(SECRET, grant, "survivor", "someone-else", "ada@example.com")).resolves.toBe(false);
    await expect(checkMergeGrant(SECRET, grant, "survivor", "other", "eve@example.com")).resolves.toBe(false);
    await expect(checkMergeGrant("wrong-secret-0123456789abcdef0123456789abcd", grant, "survivor", "other", "ada@example.com")).resolves.toBe(
      false,
    );
  });

  it("rejects a grant older than MERGE_GRANT_MINUTES", async () => {
    const now = Date.now();
    const grant = await mergeGrant(SECRET, "survivor", "other", "ada@example.com", now);
    const justBefore = now + (MERGE_GRANT_MINUTES * 60 - 1) * 1000;
    const justAfter = now + (MERGE_GRANT_MINUTES * 60 + 1) * 1000;
    await expect(checkMergeGrant(SECRET, grant, "survivor", "other", "ada@example.com", justBefore)).resolves.toBe(true);
    await expect(checkMergeGrant(SECRET, grant, "survivor", "other", "ada@example.com", justAfter)).resolves.toBe(false);
  });

  it("rejects garbage or tampered grants", async () => {
    await expect(checkMergeGrant(SECRET, undefined, "survivor", "other", "ada@example.com")).resolves.toBe(false);
    await expect(checkMergeGrant(SECRET, "not-a-grant", "survivor", "other", "ada@example.com")).resolves.toBe(false);
    const grant = await mergeGrant(SECRET, "survivor", "other", "ada@example.com");
    const tampered = grant.replace(/.$/, grant.endsWith("0") ? "1" : "0");
    await expect(checkMergeGrant(SECRET, tampered, "survivor", "other", "ada@example.com")).resolves.toBe(false);
  });
});
