import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { addCompany, addSubscription, all, run } from "@/test/crm-fixtures";
import { APPLIED_MIGRATIONS, migratedD1 } from "@/test/sqlite-d1";

const sql = (name: string) => readFileSync(new URL(`../../../../db/migrations/${name}`, import.meta.url), "utf8");

/** Відкрита вакансія компанії, що має бути в company_jobs_live за наявності підписки. */
function openJob(raw: ReturnType<typeof migratedD1>["raw"], companyId: string, id: string): void {
  run(
    raw,
    `INSERT INTO company_jobs (id, company_id, status, title, apply_url, created_via, published_at, expires_at)
     VALUES (?, ?, 'open', 'Solidity engineer', 'https://acme.io/jobs', 'web', datetime('now'), datetime('now', '+60 days'))`,
    id,
    companyId,
  );
}

describe("migration 0012_access_views", () => {
  it("rebuilds both views on a production-like database and keeps the data", () => {
    const { raw } = migratedD1(APPLIED_MIGRATIONS);
    const co = addCompany(raw);
    addSubscription(raw, co, { provider: "stripe", status: "past_due", start: "2026-01-01 00:00:00", end: "2099-01-01 00:00:00" });
    openJob(raw, co, "job_AAAAAAAAAAAAAAAAAAAA");
    // 0004: past_due рахувався від кінця періоду, тож компанія мала доступ місяцями.
    expect(all(raw, "SELECT access FROM company_access")).toEqual([{ access: "subscription" }]);

    raw.exec(sql("0012_access_views.sql"));

    expect(all(raw, "SELECT access FROM company_access")).toEqual([{ access: "pay_per_request" }]);
    expect(all(raw, "SELECT id FROM company_jobs_live")).toEqual([]);
    expect(all(raw, "SELECT COUNT(*) AS n FROM subscriptions")).toEqual([{ n: 1 }]);
    expect(all(raw, "SELECT name FROM schema_migrations WHERE name = '0012_access_views'")).toEqual([
      { name: "0012_access_views" },
    ]);
  });

  it("keeps company_jobs_live working for a company with a subscription", () => {
    const { raw } = migratedD1([...APPLIED_MIGRATIONS, "0012_access_views.sql"]);
    const co = addCompany(raw);
    addSubscription(raw, co, { provider: "manual", status: "active" });
    openJob(raw, co, "job_BBBBBBBBBBBBBBBBBBBB");
    expect(all(raw, "SELECT id, company_name FROM company_jobs_live")).toEqual([
      { id: "job_BBBBBBBBBBBBBBBBBBBB", company_name: "Acme Labs" },
    ]);
  });

  it("can be applied twice", () => {
    const { raw } = migratedD1([...APPLIED_MIGRATIONS, "0012_access_views.sql"]);
    raw.exec(sql("0012_access_views.sql"));
    expect(all(raw, "SELECT COUNT(*) AS n FROM schema_migrations WHERE name = '0012_access_views'")).toEqual([{ n: 1 }]);
    expect(all(raw, "SELECT name FROM sqlite_master WHERE type = 'view' ORDER BY name")).toEqual([
      { name: "company_access" },
      { name: "company_jobs_live" },
    ]);
  });
});
