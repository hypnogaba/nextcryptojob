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
