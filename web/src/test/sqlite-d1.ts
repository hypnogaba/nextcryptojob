// Лише для тестів: справжній SQLite (node:sqlite) під інтерфейсом D1, на який
// накочуються справжні міграції з db/migrations. Реалізує ту частину D1, яку
// використовує код: prepare/bind/first/run/all і batch як одну транзакцію.
import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { fileURLToPath } from "node:url";

const MIGRATIONS = fileURLToPath(new URL("../../../db/migrations/", import.meta.url));

export function sqliteD1(migrations: string[]): { db: D1Database; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA foreign_keys = ON"); // як у D1
  for (const name of migrations) raw.exec(readFileSync(`${MIGRATIONS}${name}.sql`, "utf8"));

  class Statement {
    constructor(
      readonly sql: string,
      readonly args: SQLInputValue[] = [],
    ) {}
    bind(...args: SQLInputValue[]) {
      return new Statement(this.sql, args);
    }
    runSync() {
      const r = raw.prepare(this.sql).run(...this.args);
      return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    }
    async first(column?: string) {
      const row = raw.prepare(this.sql).get(...this.args) as Record<string, unknown> | undefined;
      if (!row) return null;
      return column ? row[column] : { ...row };
    }
    async run() {
      return this.runSync();
    }
    async all() {
      const rows = raw.prepare(this.sql).all(...this.args);
      return { success: true, results: rows.map((r) => ({ ...r })), meta: {} };
    }
  }

  const db = {
    prepare: (sql: string) => new Statement(sql),
    async batch(statements: Statement[]) {
      raw.exec("BEGIN");
      try {
        const out = statements.map((s) => s.runSync());
        raw.exec("COMMIT");
        return out;
      } catch (e) {
        raw.exec("ROLLBACK");
        throw e;
      }
    },
  };
  return { db: db as unknown as D1Database, raw };
}
