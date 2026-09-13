import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { APPLIED_MIGRATIONS, migratedD1 } from "@/test/sqlite-d1";
import { addCompany, addSubscription, ALL_MIGRATIONS, all, crmDb, run } from "@/test/crm-fixtures";

const sql = (name: string) => readFileSync(new URL(`../../../../db/migrations/${name}`, import.meta.url), "utf8");

describe("migrations 0003_crm and 0004_billing", () => {
  it("apply after the migrations production already has, and leave those tables alone", () => {
    // Порядок продакшену: 0001, 0002, 0005, 0008, 0009 уже є; 0003 і 0004 накочуємо зараз.
    const before0003 = APPLIED_MIGRATIONS.slice(0, APPLIED_MIGRATIONS.indexOf("0003_crm.sql"));
    expect(APPLIED_MIGRATIONS.slice(before0003.length)).toEqual(["0003_crm.sql", "0004_billing.sql"]);
    const { raw } = migratedD1(before0003);
    run(raw, "INSERT INTO users (id, email) VALUES ('u1', 'ada@example.com')");
    run(raw, "INSERT INTO identities (user_id, kind, value) VALUES ('u1', 'sherlock', 'ada')");
    run(raw, "INSERT INTO cards (slug, user_id, role, score, level, display_name, formula_version) VALUES ('abcdefghij', 'u1', 'engineer', 70, 8, 'Ada', 'v5')");
    const before = all(raw, "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name");

    raw.exec(sql("0003_crm.sql"));
    raw.exec(sql("0004_billing.sql"));

    const after = all<{ type: string; name: string; sql: string }>(
      raw,
      "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table', 'index') ORDER BY name",
    );
    // Усе, що було, лишилось тим самим; нове лише додалось.
    for (const obj of before) expect(after).toContainEqual(obj);
    expect(all(raw, "SELECT id FROM users")).toEqual([{ id: "u1" }]);
    expect(all(raw, "SELECT kind FROM identities")).toEqual([{ kind: "sherlock" }]);
    expect(all(raw, "SELECT slug FROM cards")).toEqual([{ slug: "abcdefghij" }]);

    const names = all<{ name: string }>(raw, "SELECT name FROM schema_migrations ORDER BY name").map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["0003_crm", "0004_billing"]));
    const created = after.filter((o) => !before.some((b) => b.name === o.name)).map((o) => o.name);
    expect(created).toEqual(
      expect.arrayContaining(["companies", "company_members", "pipeline", "intros", "api_keys", "usage_events", "x402_payments"]),
    );
  });

  it("can be applied twice without errors or duplicate rows", () => {
    const { raw } = crmDb();
    raw.exec(sql("0003_crm.sql"));
    raw.exec(sql("0004_billing.sql"));
    const rows = all<{ n: number }>(raw, "SELECT COUNT(*) AS n FROM schema_migrations WHERE name IN ('0003_crm', '0004_billing')");
    expect(rows[0].n).toBe(2);
  });

  it("run in file order in tests", () => {
    expect(ALL_MIGRATIONS[0]).toBe("0001_core.sql");
    expect(ALL_MIGRATIONS).toEqual([...ALL_MIGRATIONS].sort());
  });
});

describe("company_access view", () => {
  it("says subscription, pay_per_request or none from company status and subscriptions", () => {
    const { raw } = crmDb();
    const paying = addCompany(raw);
    addSubscription(raw, paying, { status: "active" });
    const free = addCompany(raw);
    const expired = addCompany(raw);
    addSubscription(raw, expired, { status: "active", start: "2026-01-01 00:00:00", end: "2026-02-01 00:00:00" });
    const suspended = addCompany(raw, { status: "suspended" });
    addSubscription(raw, suspended, { status: "active" });

    const access = Object.fromEntries(
      all<{ company_id: string; access: string }>(raw, "SELECT company_id, access FROM company_access").map((r) => [
        r.company_id,
        r.access,
      ]),
    );
    expect(access[paying]).toBe("subscription");
    expect(access[free]).toBe("pay_per_request");
    expect(access[expired]).toBe("pay_per_request");
    expect(access[suspended]).toBe("none");
  });
});

describe("migration 0016_x402_no_result", () => {
  it("adds the paid-without-result columns to x402_payments without touching usage links", () => {
    const { raw } = migratedD1(ALL_MIGRATIONS.filter((m) => m < "0016"));
    const co = addCompany(raw);
    run(
      raw,
      `INSERT INTO x402_payments (id, payload_hash, request_hash, company_id, network, asset, pay_to, amount_atomic,
                                  amount_usd_cents, action, channel, status, facilitator)
       VALUES ('pay_a', 'ph', 'rh', ?, 'eip155:84532', 'usdc', 'to', '500000', 50, 'search_candidates', 'rest', 'settled', 'x402org')`,
      co,
    );
    run(raw, "INSERT INTO usage_events (company_id, channel, action, billing, x402_payment_id, status) VALUES (?, 'rest', 'search_candidates', 'x402', 'pay_a', 200)", co);
    raw.exec(sql("0016_x402_no_result.sql"));
    expect(all(raw, "SELECT status, no_result_at, refunded_at FROM x402_payments")).toEqual([
      { status: "settled", no_result_at: null, refunded_at: null },
    ]);
    expect(all(raw, "SELECT x402_payment_id FROM usage_events")).toEqual([{ x402_payment_id: "pay_a" }]);
    expect(all(raw, "SELECT name FROM schema_migrations WHERE name = '0016_x402_no_result'")).toHaveLength(1);
  });

  it("finds the audit row of a paid search by its payment id through an index, not by scanning the log", () => {
    const { raw } = crmDb();
    const plan = all<{ detail: string }>(
      raw,
      `EXPLAIN QUERY PLAN SELECT actor, meta_json FROM audit_log
        WHERE action = 'candidate.search' AND json_extract(meta_json, '$.payment_id') = ? ORDER BY id LIMIT 1`,
      "pay_x",
    ).map((r) => r.detail);
    expect(plan.join(" | ")).toContain("idx_audit_log_search_payment");
  });
});
