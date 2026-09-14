// Перенесено з NextRole (crypto-jobs-agent, scanner): src/pay.ts і plausibleSalary з src/money.ts.
/**
 * Вилка з полів ATS: період і переведення в річну суму.
 *
 * База тримає лише річні числа: картка, підбір і профіль порівнюють рік із
 * роком. Кожен ATS називає період по-своєму, і всі назви нижче взяті з живих
 * відповідей 13.09.2026:
 *
 *   Greenhouse  `pay_input_ranges[].title`: «Annual base salary range…»,
 *               «Hourly Rate:», «NY Annual Base Salary Range»
 *   Ashby       `compensation.summaryComponents[].interval`: «1 YEAR», «1 HOUR»
 *   Lever       `salaryRange.interval`: «per-year-salary», «per-hour-wage»…
 *   Getro       `compensation_period`: «year», «period_not_defined»…
 *   speedrun    `comp_period`: null (=рік), «hour», «month», «year»
 *
 * Невідомий період НЕ множимо навмання: суму беремо як річну лише тоді, коли
 * вона правдоподібна як річна (`payFor`), інакше не пишемо нічого. Саме так
 * «24 USD/hour» не стає вакансією на 24 долари на рік, а місячні 4 500 EUR
 * не стають річними.
 */

export type PayPeriod = "hour" | "day" | "week" | "month" | "year";

/** Годин на рік у повній зайнятості: 40 × 52. Те саме, що в speedrun.ts. */
const PER_YEAR: Record<PayPeriod, number> = { hour: 2080, day: 260, week: 52, month: 12, year: 1 };

/** Найменша й найбільша річна сума, які взагалі бувають. */
export const MIN_YEARLY = 1_000;
export const MAX_YEARLY = 5_000_000;

/**
 * Приблизні курси до євро: лише щоб відрізнити правдоподібну річну суму від місячної.
 * Зарплата в підборі м'який пріоритет, тож щоденний курс не вартий ані запиту, ані залежності.
 */
const TO_EUR: Record<string, number> = {
  EUR: 1, USD: 0.92, GBP: 1.17, CHF: 1.05, CAD: 0.68, AUD: 0.60, NZD: 0.55,
  SEK: 0.088, NOK: 0.086, DKK: 0.134, PLN: 0.23, CZK: 0.040, HUF: 0.0026,
  RON: 0.20, BGN: 0.51, UAH: 0.022, TRY: 0.027, ILS: 0.25, AED: 0.25,
  SAR: 0.25, INR: 0.011, SGD: 0.69, HKD: 0.12, JPY: 0.0062, KRW: 0.00068,
  CNY: 0.13, BRL: 0.17, MXN: 0.050, ARS: 0.0009, ZAR: 0.050, PHP: 0.016,
  IDR: 0.000058, VND: 0.000037, THB: 0.026, MYR: 0.20, PKR: 0.0033, NGN: 0.00060,
};

/** Нижче цього річна вилка не вилка: «від 1 000 USD» це місячна сума або уламок тексту. */
export const IMPLAUSIBLE_YEARLY = 10_000;

/** Чи вилку взагалі можна вважати річною зарплатою. */
export function plausibleSalary(
  min: number | null | undefined, max: number | null | undefined, currency: string | null | undefined,
): boolean {
  const rate = TO_EUR[(currency ?? "EUR").toUpperCase()] ?? 1;
  const top = Math.max(min ?? 0, max ?? 0) * rate;
  return top >= IMPLAUSIBLE_YEARLY;
}

/**
 * Період зі слова або фрази джерела. `null` означає «не сказано».
 *
 * «one-time» і бонуси сюди не доходять: їх відсіює той, хто кличе, бо це не
 * зарплата взагалі, а не зарплата з незнайомим періодом.
 */
export function payPeriod(text: string | null | undefined): PayPeriod | null {
  const t = (text ?? "").toLowerCase();
  if (!t.trim()) return null;
  if (/\bhour|hourly|per-hour|\/\s?hr\b/.test(t)) return "hour";
  if (/\bday\b|daily|per-day/.test(t)) return "day";
  if (/\bweek|weekly|per-week/.test(t)) return "week";
  if (/\bmonth|monthly|per-month/.test(t)) return "month";
  // Саме слово «salary» період НЕ називає: Astranis пише «Base Salary», а
  // під ним «$1,925 per week». Перша версія читала це як рік.
  if (/\byear|annual|yearly|per-year/.test(t)) return "year";
  return null;
}

/**
 * Сума в річну. `period` null або невідомий: як річна.
 *
 * `every` потрібен Ashby: інтервал там «N ОДИНИЦЯ», і «2 WEEK» означає
 * виплату раз на два тижні, тобто 26 на рік, а не 52.
 */
export function yearly(value: number | null | undefined, period: PayPeriod | null, every = 1): number | null {
  if (value === null || value === undefined || !Number.isFinite(value) || value <= 0) return null;
  const factor = period ? PER_YEAR[period] / (every > 0 ? every : 1) : 1;
  const n = Math.round(value * factor);
  return n >= MIN_YEARLY && n <= MAX_YEARLY ? n : null;
}

/** Валюта як трилітерний код, або null. Джерела шлють і «usd», і «USD», і порожнє. */
export function currencyCode(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const c = v.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

export interface Pay { salaryMin: number | null; salaryMax: number | null; salaryCurrency: string | null }

const NONE: Pay = { salaryMin: null, salaryMax: null, salaryCurrency: null };

/** Готова вилка або порожня: обидва краї неправдоподібні означають «не знаємо». */
export function pay(min: number | null, max: number | null, currency: string | null): Pay {
  if (min === null && max === null) return NONE;
  return { salaryMin: min, salaryMax: max, salaryCurrency: currency };
}

/**
 * Вилка з сум і періоду джерела.
 *
 * Коли період НЕ названо, суму беремо як річну лише тоді, коли вона
 * правдоподібна як річна (`plausibleSalary`). Інакше це майже напевно місяць:
 * Recruitee віддає `period: null` поруч із «4500 EUR» при сусідніх вакансіях
 * того самого роботодавця з `month`. Записати таке як річне означало б
 * вигадати бідну зарплату.
 */
export function payFor(lo: number | null, hi: number | null, currency: string | null,
                       period: PayPeriod | null, every = 1): Pay {
  const min = yearly(lo, period, every);
  const max = yearly(hi, period, every);
  if (period === null && !plausibleSalary(min, max, currency)) return NONE;
  return pay(min, max, currency);
}

// ── Greenhouse ────────────────────────────────────────────────
export interface GreenhouseRange {
  min_cents?: number | null; max_cents?: number | null;
  currency_type?: string | null; title?: string | null; blurb?: string | null;
}

/**
 * `pay_input_ranges` приходить лише з `?pay_transparency=true`.
 *
 * Діапазонів буває кілька (за штатом чи містом). Беремо перший: роботодавець
 * ставить його першим. Період шукаємо в назві діапазону, потім у тексті під ним.
 */
export function greenhousePay(ranges: GreenhouseRange[] | null | undefined): Pay {
  const r = (ranges ?? []).find((x) => x && (x.min_cents || x.max_cents));
  if (!r) return NONE;
  const blurb = (r.blurb ?? "").replace(/<[^>]+>/g, " ");
  const period = payPeriod(r.title) ?? payPeriod(blurb);
  const cents = (v: number | null | undefined) => (typeof v === "number" ? v / 100 : null);
  return payFor(cents(r.min_cents), cents(r.max_cents), currencyCode(r.currency_type), period);
}

// ── Ashby ─────────────────────────────────────────────────────
export interface AshbyComponent {
  compensationType?: string | null; interval?: string | null;
  currencyCode?: string | null; minValue?: number | null; maxValue?: number | null;
}

/**
 * `compensation` приходить лише з `?includeCompensation=true`.
 *
 * У `summaryComponents` поруч лежать Salary, Bonus, Commission і частка в
 * капіталі. Зарплата лише перша: бонус у вилці підняв би її там, де людина
 * порівнює базу з базою.
 */
export function ashbyPay(c: { summaryComponents?: AshbyComponent[] | null } | null | undefined): Pay {
  const s = (c?.summaryComponents ?? []).find((x) => (x.compensationType ?? "").toLowerCase() === "salary");
  if (!s) return NONE;
  const m = /^\s*(\d+)?\s*([a-z]+)/i.exec(s.interval ?? "");
  const every = m?.[1] ? Number(m[1]) : 1;
  const period = payPeriod(m?.[2] ?? null);
  return payFor(s.minValue ?? null, s.maxValue ?? null, currencyCode(s.currencyCode), period, every);
}

// ── Lever ─────────────────────────────────────────────────────
/** Погодинна й місячна ставки переводяться в річні; разова виплата («one-time») не зарплата. */
export function leverPay(r: { min?: number; max?: number; currency?: string; interval?: string } | null | undefined): Pay {
  if (!r) return NONE;
  if (/one-?time/i.test(r.interval ?? "")) return NONE;
  const period = payPeriod(r.interval) ?? "year";
  return pay(yearly(r.min, period), yearly(r.max, period), currencyCode(r.currency));
}
