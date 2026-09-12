import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { migratedD1 } from "@/test/sqlite-d1";
import { addCompany, addSubscription, ALL_MIGRATIONS, all, crmDb, run } from "@/test/crm-fixtures";

const sql = (name: string) => readFileSync(new URL(`../../../../db/migrations/${name}`, import.meta.url), "utf8");

describe("migrations 0003_crm and 0004_billing", () => {
  it("apply after the migrations production already has, and leave those tables alone", () => {
    // Порядок продакшену: 0001, 0002, 0005, 0008, 0009 уже є; 0003 і 0004 накочуємо зараз.
    const { raw } = migratedD1(["0001_core.sql", "0002_auth.sql", "0005_cards.sql", "0008_sources_v5.sql", "0009_users_email_lower.sql"]);
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
