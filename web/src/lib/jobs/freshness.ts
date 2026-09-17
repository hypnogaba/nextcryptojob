// Станом на який день вакансія актуальна (власник 16.09, j1): коли її опубліковано і коли ми
// востаннє бачили її відкритою. Одна функція для /jobs, надісланого раніше, збереженого й /jobs/<id>.

const DAY = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const DAY_YEAR = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export type FreshnessInput = {
  /** Дата публікації з джерела (мс); null, якщо джерело її не дало. */
  postedMs: number | null;
  /** Коли скан побачив вакансію вперше (мс); замінює дату публікації, якщо її немає. */
  firstSeenMs: number | null;
  /** Коли вакансію востаннє бачили відкритою (мс); null, якщо не знаємо. */
  checkedMs: number | null;
};

function day(ms: number, now: Date): string {
  return new Date(ms).getUTCFullYear() === now.getUTCFullYear() ? DAY.format(ms) : DAY_YEAR.format(ms);
}

/** «Posted Sep 3. Still open on Sep 17.»; «Found Sep 3.», якщо дати публікації немає; null, якщо дат немає зовсім. */
export function freshnessLine(f: FreshnessInput, now: Date): string | null {
  const parts: string[] = [];
  if (f.postedMs !== null) parts.push(`Posted ${day(f.postedMs, now)}.`);
  else if (f.firstSeenMs !== null) parts.push(`Found ${day(f.firstSeenMs, now)}.`);
  // Майбутня дата (годинник джерела) не буває «ще відкрита»: обрізаємо до сьогодні.
  if (f.checkedMs !== null) parts.push(`Still open on ${day(Math.min(f.checkedMs, now.getTime()), now)}.`);
  return parts.length ? parts.join(" ") : null;
}
