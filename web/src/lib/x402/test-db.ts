import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * Справжній SQLite під інтерфейсом D1 для тестів (лише Node, у Worker не імпортувати).
 *
 * Спільного помічника D1 для тестів у репозиторії ще немає, тож цей мінімальний
 * живе поруч з x402. Без залежностей: `node:sqlite` вбудований у Node 24.
 * Поведінка, на яку спирається код і яку тут відтворено як у D1:
 * - зовнішні ключі ввімкнені (D1 так працює завжди);
 * - `undefined` у bind дає помилку (D1_TYPE_ERROR), булеві стають 1/0;
 * - `run()` повертає `meta.changes`, `batch()` іде однією транзакцією з відкатом.
 */

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../../db/migrations/", import.meta.url));

type Row = Record<string, unknown>;

function toSqlValue(value: unknown): SQLInputValue {
  if (value === undefined) throw new TypeError("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'");
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return value as SQLInputValue;
}

const WRITE = /^\s*(insert|update|delete|replace)\b/i;

class TestStatement {
  constructor(
    private readonly sqlite: DatabaseSync,
    private readonly sql: string,
    private readonly params: SQLInputValue[] = [],
  ) {}

  bind(...values: unknown[]): TestStatement {
    return new TestStatement(this.sqlite, this.sql, values.map(toSqlValue));
  }

  /** Виконує інструкцію; спільне для run/all/first/raw і batch. */
  execute(): { results: Row[]; changes: number; lastRowId: number } {
    try {
      const stmt = this.sqlite.prepare(this.sql);
      if (stmt.columns().length > 0) {
        const results = stmt.all(...this.params).map((r) => ({ ...r }) as Row);
        const changes = WRITE.test(this.sql) ? Number((this.sqlite.prepare("SELECT changes() AS c").get() as Row).c) : 0;
        return { results, changes, lastRowId: 0 };
      }
      const r = stmt.run(...this.params);
      return { results: [], changes: Number(r.changes), lastRowId: Number(r.lastInsertRowid) };
    } catch (error) {
      throw new Error(`D1_ERROR: ${(error as Error).message}`, { cause: error });
    }
  }

  /** Синхронний результат у формі D1Result. */
  result() {
    const { results, changes, lastRowId } = this.execute();
    return {
      success: true as const,
      results,
      meta: {
        duration: 0,
        changes,
        last_row_id: lastRowId,
        changed_db: changes > 0,
        rows_read: results.length,
        rows_written: changes,
        size_after: 0,
      },
    };
  }

  async run() {
    return this.result();
  }

  async all() {
    return this.result();
  }

  async first(column?: string) {
    const row = this.execute().results[0];
    if (!row) return null;
    return column === undefined ? row : (row[column] ?? null);
  }

  async raw(options?: { columnNames?: boolean }) {
    const rows = this.execute().results;
    const values = rows.map((r) => Object.values(r));
    if (options?.columnNames) return [rows[0] ? Object.keys(rows[0]) : [], ...values];
    return values;
  }
}

export interface TestDb {
  /** Для коду, що чекає прив'язку D1. */
  db: D1Database;
  /** Прямий доступ для перевірок у тестах. */
  sqlite: DatabaseSync;
  close(): void;
}

/**
 * База в пам'яті з накоченими міграціями `db/migrations` до `upTo` включно
 * (типово 0001–0004: ядро, вхід, CRM, оплата).
 */
export function createTestDb(upTo = "0004"): TestDb {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f) && f.slice(0, 4) <= upTo)
    .sort();
  for (const file of files) sqlite.exec(readFileSync(MIGRATIONS_DIR + file, "utf8"));

  const db = {
    prepare: (sql: string) => new TestStatement(sqlite, sql),
    async batch(statements: TestStatement[]) {
      sqlite.exec("BEGIN");
      try {
        const results = statements.map((s) => s.result());
        sqlite.exec("COMMIT");
        return results;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },
  };

  return { db: db as unknown as D1Database, sqlite, close: () => sqlite.close() };
}
