// Лише для тестів: справжній SQLite (better-sqlite3) з поверхнею D1Client (query / run / batch).
// У dist не потрапляє (tsconfig.json exclude), тож продукту better-sqlite3 не потрібен.
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { D1Statement, StatementOptions } from "../d1.js";
import type { Db } from "../pipeline/db.js";

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../../../db/migrations");
/** Міграції, від яких залежить конвеєр (ядро і перебудова джерел v5). */
export const PIPELINE_MIGRATIONS = ["0001_core.sql", "0008_sources_v5.sql"];
/**
 * Міграції добірки: ядро, вакансії компаній і подання доступу (0003, 0004, 0012), sent і digest_runs
 * (0006), пауза добірки users.digest_paused (0011), своя роль словами users.role_text (0020).
 */
export const DIGEST_MIGRATIONS = [
  "0001_core.sql", "0003_crm.sql", "0004_billing.sql", "0006_digest.sql", "0011_user_settings.sql", "0012_access_views.sql",
  "0020_role_text.sql",
];

type Param = string | number | bigint | Buffer | null;
const bind = (params: unknown[] = []): Param[] =>
  params.map((p) => (p === undefined ? null : typeof p === "boolean" ? (p ? 1 : 0) : (p as Param)));

/** Мить між інструкціями, як мережа D1: одночасні виклики справді перемежовуються. */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

export class SqliteD1 implements Db {
  readonly sqlite: Database.Database;
  /** Скільки викликів D1 (query/run/batch) пройшло; пакет рахується одним. */
  calls = 0;
  /** Гачок перед кожною інструкцією (зокрема всередині пакета); кинутий виняток відкочує пакет. */
  beforeStatement: ((sql: string) => void) | null = null;

  constructor(migrations: readonly string[] = PIPELINE_MIGRATIONS) {
    this.sqlite = new Database(":memory:");
    // D1 перевіряє зовнішні ключі; SQLite за замовчуванням ні.
    this.sqlite.pragma("foreign_keys = ON");
    for (const m of migrations) this.sqlite.exec(readFileSync(join(MIGRATIONS_DIR, m), "utf8"));
  }

  private prepare(sql: string): Database.Statement {
    this.beforeStatement?.(sql);
    return this.sqlite.prepare(sql);
  }

  async query<T>(sql: string, params: unknown[] = [], _o?: StatementOptions): Promise<T[]> {
    await tick();
    this.calls++;
    const st = this.prepare(sql);
    if (st.reader) return st.all(...bind(params)) as T[];
    st.run(...bind(params));
    return [];
  }

  async run(sql: string, params: unknown[] = [], _o?: StatementOptions): Promise<{ changes: number }> {
    await tick();
    this.calls++;
    const st = this.prepare(sql);
    if (st.reader) { st.all(...bind(params)); return { changes: this.sqlite.prepare("SELECT changes() AS n").pluck().get() as number }; }
    return { changes: st.run(...bind(params)).changes };
  }

  /** Як D1: увесь пакет одна транзакція. */
  async batch(statements: D1Statement[], _o?: StatementOptions): Promise<void> {
    await tick();
    this.calls++;
    this.sqlite.transaction(() => {
      for (const s of statements) {
        const st = this.prepare(s.sql);
        if (st.reader) st.all(...bind(s.params)); else st.run(...bind(s.params));
      }
    })();
  }

  /** Синхронний доступ для підготовки й перевірок у тестах. */
  exec(sql: string, ...params: unknown[]): void {
    this.sqlite.prepare(sql).run(...bind(params));
  }

  all<T>(sql: string, ...params: unknown[]): T[] {
    return this.sqlite.prepare(sql).all(...bind(params)) as T[];
  }

  get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.sqlite.prepare(sql).get(...bind(params)) as T | undefined;
  }

  addUser(id: string): void {
    this.exec("INSERT INTO users (id) VALUES (?)", id);
  }

  addIdentity(userId: string, kind: string, value: string, verified = false): void {
    this.exec("INSERT INTO identities (user_id, kind, value, verified_at) VALUES (?, ?, ?, ?)",
      userId, kind, value, verified ? "2026-09-01 00:00:00" : null);
  }

  close(): void {
    this.sqlite.close();
  }
}
