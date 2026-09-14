/**
 * Як показати вакансію добірки: у листі (email.ts) і на сторінці /jobs.
 * Правила ті самі, що в engine (engine/src/digest/deliver.ts і match.ts), щоб лист,
 * Telegram і сторінка казали про вакансію однаково.
 */

/** Дані з джерел: без довгого тире (договір), без зайвих пробілів, не довше max. */
export function cleanText(text: string, max = 140): string {
  const t = text.replace(/&amp;/g, "&").replace(/\u2014/g, "-").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3).trimEnd()}...` : t;
}

/**
 * Адреса вакансії: http(s) або mailto (так подають вакансії компаній, 0003 apply_url).
 * Інше (javascript:, data:) з чужих дощок посиланням не стає.
 *
 * Лише перевірка, без нормалізації: повертається та сама адреса (без пробілів по краях), а не
 * `new URL().toString()`. Умови web3.career забороняють міняти їхній apply_url хоч на символ
 * (lib/jobs/link.ts). Адреса з пробілом чи керівним символом усередині посиланням не стає: її
 * довелось би переписати.
 */
export function safeUrl(raw: string | null | undefined): string | null {
  const url = raw?.trim();
  if (!url || /[\s\u0000-\u001f\u007f]/.test(url)) return null;
  try {
    const u = new URL(url);
    return ["https:", "http:", "mailto:"].includes(u.protocol) ? url : null;
  } catch {
    return null;
  }
}

/** «Sep 12» з YYYY-MM-DD (дата людини). */
export function shortDate(localDate: string): string {
  const d = new Date(`${localDate}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? localDate
    : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** «Sat, Sep 12» з YYYY-MM-DD: заголовок дня на сторінці. */
export function dayLabel(localDate: string): string {
  const d = new Date(`${localDate}T12:00:00Z`);
  return Number.isNaN(d.getTime())
    ? localDate
    : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

export const hourLabel = (h: number): string => `${String(h).padStart(2, "0")}:00`;

// ---------------- зарплата (як formatSalary у engine/src/digest/match.ts) ----------------

export type Salary = { min: number | null; max: number | null; currency: string | null; period: "year" | "month" };

/** Річна сума лише в правдоподібних межах: 1 000 у вилці це заглушка, а не зарплата. */
export const MIN_ANNUAL = 10_000;
export const MAX_ANNUAL = 5_000_000;
export const plausibleAnnual = (v: number): boolean => v >= MIN_ANNUAL && v <= MAX_ANNUAL;

/**
 * Одна межа зарплати для всього сайту (як annualRange в engine/src/digest/match.ts): сума
 * від 10 000 до 5 000 000 за рік, місячна множиться на 12. Нею перевіряє збереження
 * вакансії (lib/crm/jobs.ts), її показують сторінки, лист, search_jobs, JobPosting і пост у X.
 */
export function plausibleSalary(v: number, period: "year" | "month"): boolean {
  return plausibleAnnual(v * (period === "month" ? 12 : 1));
}

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

function money(n: number, currency: string | null): string {
  const k = n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
  const cur = (currency ?? "").toUpperCase();
  const sym = SYMBOL[cur];
  return sym ? `${sym}${k}` : cur ? `${cur} ${k}` : k;
}

/** «$120k to $150k», «from $120k», «up to €90k», «$8k to $10k a month»; null, якщо показати нічого. */
export function formatSalary(s: Salary | null): string | null {
  if (!s) return null;
  const k = s.period === "month" ? 12 : 1;
  const okMin = s.min !== null && plausibleAnnual(s.min * k) ? s.min : null;
  const okMax = s.max !== null && plausibleAnnual(s.max * k) ? s.max : null;
  const tail = s.period === "month" ? " a month" : "";
  if (okMin !== null && okMax !== null && okMax > okMin) return `${money(okMin, s.currency)} to ${money(okMax, s.currency)}${tail}`;
  if (okMin !== null) return `from ${money(okMin, s.currency)}${tail}`;
  if (okMax !== null) return `up to ${money(okMax, s.currency)}${tail}`;
  return null;
}

/**
 * Оцінка дошки підписом: «est. $180k to $225k (web3.career estimate)»; null, якщо показати нічого.
 * Лише для показу (приглушено) там, де вилки роботодавця немає; як і estimateText в engine/src/digest/jobs.ts.
 */
export function estimateText(e: (Salary & { by: string }) | null | undefined): string | null {
  const money = e ? formatSalary(e) : null;
  return e && money ? `est. ${money} (${e.by} estimate)` : null;
}

/** Місце вакансії компанії, як у engine (companyJob): «Remote», «Lisbon», «Remote or Lisbon». */
export function companyJobLocation(remoteMode: string, city: string | null): string | null {
  const modes = remoteMode.split(",").map((m) => m.trim());
  const place = modes.includes("city") ? city?.trim() || null : null;
  return [modes.includes("remote") ? "Remote" : null, place].filter(Boolean).join(" or ") || null;
}
