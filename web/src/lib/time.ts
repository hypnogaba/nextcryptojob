/**
 * Час для бази: формат SQLite `YYYY-MM-DD HH:MM:SS`, UTC, як у datetime('now').
 *
 * ISO з `T` і `Z` у базу не пишемо (docs/contracts.md, розділ 9): рядки
 * порівнюються посимвольно, `'T'` стоїть після `' '`, тож прострочена мітка
 * в ISO виглядала б пізнішою за будь-який datetime('now') того самого дня.
 * Де можна, час краще рахувати в самому SQL: datetime('now', '+10 minutes').
 */
export function sqlTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

const SQL_TIME = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})$/;

/**
 * Час з бази для API: ISO 8601 з `Z` (специфікація CRM, 3.5).
 * `'2026-09-12 10:15:00'` → `'2026-09-12T10:15:00Z'`. NULL лишається null.
 * Рядок не у форматі SQLite означає помилку запису, тож кидаємо, а не вгадуємо.
 */
export function isoTime(value: string): string;
export function isoTime(value: string | null): string | null;
export function isoTime(value: string | null): string | null {
  if (value === null) return null;
  const m = SQL_TIME.exec(value);
  if (!m) throw new Error(`not a SQLite UTC time: ${JSON.stringify(value)}`);
  return `${m[1]}T${m[2]}Z`;
}

/** Початок доби UTC, у якій лежить `date`. */
export function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Початок календарного місяця UTC, у якому лежить `date`. */
export function startOfUtcMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

/** Дата з рядка SQLite (UTC). */
export function fromSqlTime(value: string): Date {
  return new Date(`${value.replace(" ", "T")}Z`);
}
