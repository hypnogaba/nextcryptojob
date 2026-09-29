import { beforeEach, describe, expect, it } from "vitest";
import { jobsDbFromEnv } from "../digest/jobs-db.js";
import { __resetLimiters } from "../limits.js";
import { jobsD1FromEnv } from "./env.js";

const BASE = { CF_ACCOUNT_ID: "acc", CF_D1_DATABASE_ID: "main-db", CF_JOBS_D1_DATABASE_ID: "jobs-db", CF_API_TOKEN: "write-token" };
const ok = JSON.stringify({ success: true, result: [{ success: true, results: [{ n: 1 }], meta: { changes: 0 } }], errors: [] });

/** fetch, що запам'ятовує токен, з яким його кликали. */
function spy(): { impl: typeof fetch; tokens: string[] } {
  const tokens: string[] = [];
  const impl = (async (_url: string, init: RequestInit) => {
    tokens.push(String((init.headers as Record<string, string>).Authorization));
    return new Response(ok, { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, tokens };
}

beforeEach(() => __resetLimiters());

describe("токен бази вакансій (G-f)", () => {
  it("добірка (лише читання) бере окремий CF_JOBS_D1_READ_TOKEN, якщо він заданий", async () => {
    const f = spy();
    await jobsDbFromEnv({ ...BASE, CF_JOBS_D1_READ_TOKEN: "read-token" }, f.impl).select("SELECT 1");
    expect(f.tokens).toEqual(["Bearer read-token"]);
  });

  it("без окремого токена добірка бере CF_API_TOKEN, як раніше; порожній рядок теж не токен", async () => {
    const f = spy();
    await jobsDbFromEnv(BASE, f.impl).select("SELECT 1");
    await jobsDbFromEnv({ ...BASE, CF_JOBS_D1_READ_TOKEN: "  " }, f.impl).select("SELECT 1");
    expect(f.tokens).toEqual(["Bearer write-token", "Bearer write-token"]);
  });

  it("сканер (запис) ніколи не бере токен для читання", async () => {
    const f = spy();
    await jobsD1FromEnv({ ...BASE, CF_JOBS_D1_READ_TOKEN: "read-token" }, { fetchImpl: f.impl }).run("UPDATE t SET a = 1", [], { idempotent: true }).catch(() => undefined);
    expect(f.tokens).toEqual(["Bearer write-token"]);
  });

  it("окремий токен читання замінює потребу в CF_API_TOKEN лише для читання; акаунт усе одно потрібен", () => {
    const { CF_API_TOKEN: _drop, ...noWrite } = BASE;
    expect(() => jobsDbFromEnv({ ...noWrite, CF_JOBS_D1_READ_TOKEN: "read-token" })).not.toThrow();
    expect(() => jobsD1FromEnv(noWrite)).toThrow(/CF_API_TOKEN/);
    expect(() => jobsDbFromEnv({ ...noWrite, CF_ACCOUNT_ID: "", CF_JOBS_D1_READ_TOKEN: "r" })).toThrow(/CF_ACCOUNT_ID/);
  });
});
