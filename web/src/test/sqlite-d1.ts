import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * Справжній SQLite (node:sqlite) під інтерфейсом D1 для тестів: ті самі
 * міграції, що в продакшені, ті самі datetime('now', ...), UPSERT і RETURNING.
 * Реалізовано лише те, чим користується код: prepare/bind/first/all/run/batch.
 */

/** Усі міграції, накочені на продакшн, у порядку накочування. */
export const APPLIED_MIGRATIONS = [
  "0001_core.sql",
  "0002_auth.sql",
  "0005_cards.sql",
  "0008_sources_v5.sql",
  "0009_users_email_lower.sql",
  "0010_score_jobs_user.sql",
  // Накочено 2026-09-12 доріжкою CRM (T1), після 0010.
  "0003_crm.sql",
  "0004_billing.sql",
];

/**
 * Накочені на продакшн після 0003 і 0004, у тому ж порядку. Окремим списком лише
 * тому, що crm/migrations.test.ts перевіряє, що 0003 і 0004 закривають
 * APPLIED_MIGRATIONS; коли той тест це відпустить, список зливається з верхнім.
 */
export const APPLIED_AFTER_CRM = [
  // 2026-09-12, доріжка оплати (T8): перебудова подань доступу.
  "0012_access_views.sql",
  // 2026-09-12, доріжка web (W6, налаштування): users.digest_paused. Накочено після 0012.
  "0011_user_settings.sql",
  // Доріжка web (W3b): sessions.method. Накочено (за словами controller).
  "0013_session_method.sql",
  // Доріжка engine (E7): sent і digest_runs. Накочено (за словами controller).
  "0006_digest.sql",
  // Доріжка web (W7): digest_emails.
  "0014_digest_email.sql",
  // Доріжка web (оплата й агенти): «Paid without result» і індекс повтору пошуку. Ще НЕ накочено.
  "0016_x402_no_result.sql",
  // Доріжка web (CRM, T7 і T12): збережені пошуки й переходи "Apply".
  "0017_saved_search_baseline.sql",
  "0018_apply_click_seen.sql",
  // Доріжка web (головна адмінки): cron_runs, app_settings, індекс digest_runs(created_at). Ще НЕ накочено.
  "0019_admin_home.sql",
  // Доріжка web (інструменти власника): відвідування, сповіщення власнику, демо. Ще НЕ накочено.
  "0021_owner_tools.sql",
];

function toSql(value: unknown): SQLInputValue {
  // D1 не приймає undefined і відмовляє з помилкою; тест має впасти так само.
  if (value === undefined) throw new TypeError("D1_TYPE_ERROR: undefined is not a supported type");
  if (typeof value === "boolean") return value ? 1 : 0;
  return value as SQLInputValue;
}

type Result = { success: true; results: Record<string, unknown>[]; meta: { changes: number; last_row_id: number } };

class Statement {
  constructor(
    private readonly raw: DatabaseSync,
    private readonly sql: string,
    private readonly params: SQLInputValue[] = [],
  ) {}

  bind(...params: unknown[]): Statement {
    return new Statement(this.raw, this.sql, params.map(toSql));
  }

  async first<T>(column?: string): Promise<T | null> {
    const row = this.raw.prepare(this.sql).get(...this.params);
    if (!row) return null;
    return (column ? row[column] : { ...row }) as T;
  }

  async all<T>(): Promise<{ success: true; results: T[]; meta: object }> {
    const rows = this.raw.prepare(this.sql).all(...this.params);
    return { success: true, results: rows.map((r) => ({ ...r }) as T), meta: {} };
  }

  async run(): Promise<Result> {
    return this.execute();
  }

  execute(): Result {
    const stmt = this.raw.prepare(this.sql);
    if (stmt.columns().length > 0) {
      const results = stmt.all(...this.params).map((r) => ({ ...r }));
      return { success: true, results, meta: { changes: results.length, last_row_id: 0 } };
    }
    const r = stmt.run(...this.params);
    return {
      success: true,
      results: [],
      meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) },
    };
  }
}

export type TestDb = { raw: DatabaseSync; d1: D1Database };

/** Порожня база в пам'яті з міграціями (за замовчуванням усі накочені). */
export function migratedD1(migrations: string[] = [...APPLIED_MIGRATIONS, ...APPLIED_AFTER_CRM]): TestDb {
  const raw = new DatabaseSync(":memory:");
  // D1 перевіряє зовнішні ключі; тест теж.
  raw.exec("PRAGMA foreign_keys = ON");
  for (const name of migrations) {
    const file = name.endsWith(".sql") ? name : `${name}.sql`;
    raw.exec(readFileSync(new URL(`../../../db/migrations/${file}`, import.meta.url), "utf8"));
  }
  const d1 = {
    prepare: (sql: string) => new Statement(raw, sql),
    async batch(statements: Statement[]) {
      raw.exec("BEGIN");
      try {
        const out = statements.map((s) => s.execute());
        raw.exec("COMMIT");
        return out;
      } catch (err) {
        raw.exec("ROLLBACK");
        throw err;
      }
    },
  };
  return { raw, d1: d1 as unknown as D1Database };
}

/** Сумісність із тестами карток: імена міграцій без `.sql`, повертає { db, raw }. */
export function sqliteD1(migrations: string[]): { db: D1Database; raw: DatabaseSync } {
  const { raw, d1 } = migratedD1(migrations);
  return { db: d1, raw };
}
