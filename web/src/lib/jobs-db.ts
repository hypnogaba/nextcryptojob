import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Доступ до бази вакансій NextRole (binding JOBS_DB), лише читання.
 *
 * База спільна з живим NextRole, тож запис звідси зламав би чужий продукт.
 * Прив'язка D1 не вміє бути read-only сама, тому межу тримає код: будь-який
 * запит іде лише через цей модуль і лише як одна інструкція SELECT або WITH.
 * ESLint (eslint.config.mjs) забороняє торкатися JOBS_DB поза цим файлом.
 */

export class ReadOnlySqlError extends Error {
  constructor(reason: string) {
    super(`JOBS_DB is read-only: ${reason}`);
    this.name = "ReadOnlySqlError";
  }
}

// Слова, яким нема місця в одній інструкції SELECT. WITH у SQLite може
// передувати INSERT/UPDATE/DELETE, тому перевірка першого слова замало.
const FORBIDDEN = /\b(insert|update|delete|drop|create|alter|attach|detach|pragma|vacuum|reindex)\b|\breplace\s+into\b/i;

/**
 * Прибирає рядки, лапковані імена й коментарі, щоб перевіряти лише сам код:
 * `;` чи ключове слово всередині рядка не є інструкцією.
 */
function codeOnly(sql: string): string {
  let out = "";
  let i = 0;
  const closers: Record<string, string> = { "'": "'", '"': '"', "`": "`", "[": "]" };
  while (i < sql.length) {
    const ch = sql[i];
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
      const close = closers[ch];
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) throw new ReadOnlySqlError("unterminated quote");
        if (sql[j] === close) {
          // Подвоєна лапка всередині рядка: '' або "".
          if (close !== "]" && sql[j + 1] === close) {
            j += 2;
            continue;
          }
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
  if (!/^(select|with)\b/i.test(code)) {
    throw new ReadOnlySqlError("only SELECT or WITH statements are allowed");
  }
  const bad = code.match(FORBIDDEN);
  if (bad) throw new ReadOnlySqlError(`"${bad[0]}" is not allowed`);
}

export type JobsDb = {
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
  first<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T | null>;
};

export function readOnlyJobsDb(binding: D1Database): JobsDb {
  const prepare = (sql: string, params: unknown[]) => {
    assertReadOnlySql(sql);
    return binding.prepare(sql).bind(...params);
  };
  return {
    async all<T>(sql: string, ...params: unknown[]) {
      const { results } = await prepare(sql, params).all<T>();
      return results;
    },
    async first<T>(sql: string, ...params: unknown[]) {
      return prepare(sql, params).first<T>();
    },
  };
}

/** База вакансій з оточення Worker. Викликати під час запиту. */
export function jobsDb(): JobsDb {
  return readOnlyJobsDb(getCloudflareContext().env.JOBS_DB);
}
