// База вакансій NextRole (D1 `crypto-jobs-agent`), лише читання.
//
// База спільна з живим NextRole: запис звідси зламав би чужий продукт. Токен
// Cloudflare уміє писати, тож межу тримає код: цей модуль віддає назовні лише
// select, і кожен запит мусить бути рівно однією інструкцією SELECT або WITH.
// Перевірку перенесено з web/src/lib/jobs-db.ts (там та сама межа для Worker).
import { D1Client, type D1Meta } from "../d1.js";
import type { EngineEnv } from "../pipeline/registry.js";

/** D1 `crypto-jobs-agent` (NextRole). Той самий акаунт і токен, що й наша база. */
export const NEXTROLE_JOBS_DB_ID = "0bf4b998-cbdc-474b-b739-eb6e6e7d5a9d";

export class ReadOnlySqlError extends Error {
  constructor(reason: string) {
    super(`jobs DB is read-only: ${reason}`);
    this.name = "ReadOnlySqlError";
  }
}

// Слова, яким нема місця в одній інструкції SELECT. WITH у SQLite може
// передувати INSERT/UPDATE/DELETE, тому перевірки першого слова замало.
const FORBIDDEN = /\b(insert|update|delete|drop|create|alter|attach|detach|pragma|vacuum|reindex|analyze)\b|\breplace\s+into\b/i;

/**
 * Прибирає рядки, лапковані імена й коментарі, щоб перевіряти лише сам код:
 * `;` чи ключове слово всередині рядка не є інструкцією.
 */
function codeOnly(sql: string): string {
  let out = "";
  let i = 0;
  const closers: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };
  while (i < sql.length) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (ch === "-" && next === "-") {
      const end = sql.indexOf("\n", i);
      i = end === -1 ? sql.length : end;
      out += " ";
    } else if (ch === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end === -1) throw new ReadOnlySqlError("unterminated comment");
      i = end + 2;
      out += " ";
    } else if (ch in closers) {
      const close = closers[ch]!;
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new ReadOnlySqlError("unterminated quote");
        if (sql[j] === close) {
          // Подвоєна лапка всередині рядка: '' або "".
          if (close !== "]" && sql[j + 1] === close) { j += 2; continue; }
          break;
        }
        j++;
      }
      i = j + 1;
      out += " x ";
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

/** Кидає ReadOnlySqlError, якщо sql не є рівно однією інструкцією SELECT/WITH. */
export function assertReadOnlySql(sql: string): void {
  const code = codeOnly(sql).trim().replace(/;\s*$/, "").trim();
  if (code === "") throw new ReadOnlySqlError("empty statement");
  if (code.includes(";")) throw new ReadOnlySqlError("only one statement is allowed");
  if (!/^(select|with)\b/i.test(code)) throw new ReadOnlySqlError("only SELECT or WITH statements are allowed");
  const bad = code.match(FORBIDDEN);
  if (bad) throw new ReadOnlySqlError(`"${bad[0]}" is not allowed`);
}

export type SelectResult<T> = { rows: T[]; meta: D1Meta; wallMs: number };

/** Єдина поверхня бази вакансій: читання. Ні run, ні batch, ні execute тут немає. */
export interface JobsDb {
  select<T>(sql: string, params?: unknown[]): Promise<SelectResult<T>>;
}

/** Що обгортка бере від клієнта: D1Client у продукті, SQLite у тестах (без meta). */
export interface SelectBackend {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  queryWithMeta?<T>(sql: string, params?: unknown[]): Promise<{ results: T[]; meta: D1Meta }>;
}

const NO_META: D1Meta = { rowsRead: null, rowsWritten: null, durationMs: null };

export function readOnlyJobsDb(backend: SelectBackend): JobsDb {
  return Object.freeze({
    async select<T>(sql: string, params: unknown[] = []): Promise<SelectResult<T>> {
      assertReadOnlySql(sql);
      const t0 = performance.now();
      if (backend.queryWithMeta) {
        const { results, meta } = await backend.queryWithMeta<T>(sql, params);
        return { rows: results, meta, wallMs: Math.round(performance.now() - t0) };
      }
      const rows = await backend.query<T>(sql, params);
      return { rows, meta: NO_META, wallMs: Math.round(performance.now() - t0) };
    },
  });
}

/**
 * База вакансій з оточення engine: CF_ACCOUNT_ID і CF_API_TOKEN ті самі, що для нашої
 * бази; JOBS_D1_DATABASE_ID необов'язковий (типово crypto-jobs-agent NextRole).
 */
export function jobsDbFromEnv(env: EngineEnv): JobsDb {
  const missing = ["CF_ACCOUNT_ID", "CF_API_TOKEN"].filter((k) => !env[k]);
  if (missing.length) {
    throw new Error(`немає змінних оточення для бази вакансій: ${missing.join(", ")} (див. /etc/nextcryptojob-engine.env)`);
  }
  return readOnlyJobsDb(new D1Client({
    accountId: env.CF_ACCOUNT_ID!, databaseId: env.JOBS_D1_DATABASE_ID || NEXTROLE_JOBS_DB_ID, token: env.CF_API_TOKEN!,
  }));
}
