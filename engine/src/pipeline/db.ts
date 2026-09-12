import { D1Client, type D1Statement, type StatementOptions } from "../d1.js";
import type { EngineEnv } from "./registry.js";

/**
 * Поверхня бази, якою користується конвеєр. D1Client (d1.ts) її має;
 * тести підставляють справжній SQLite з тією самою поверхнею (src/testing/sqlite-d1.ts).
 */
export interface Db {
  query<T>(sql: string, params?: unknown[], opts?: StatementOptions): Promise<T[]>;
  run(sql: string, params?: unknown[], opts?: StatementOptions): Promise<{ changes: number }>;
  /** Одна транзакція D1 на кожні 50 інструкцій. Конвеєр кладе запис людини в один пакет. */
  batch(statements: D1Statement[], opts?: StatementOptions): Promise<void>;
}

export const D1_ENV = ["CF_ACCOUNT_ID", "CF_D1_DATABASE_ID", "CF_API_TOKEN"] as const;

/** D1 з облікових даних оточення (docs/contracts.md §6). Без них ясна помилка з назвами змінних. */
export function dbFromEnv(env: EngineEnv): Db {
  const missing = D1_ENV.filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`немає змінних оточення для D1: ${missing.join(", ")} (див. /etc/nextcryptojob-engine.env)`);
  }
  return new D1Client({ accountId: env.CF_ACCOUNT_ID!, databaseId: env.CF_D1_DATABASE_ID!, token: env.CF_API_TOKEN! });
}
