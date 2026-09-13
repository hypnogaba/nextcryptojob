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
 */
export function safeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    return ["https:", "http:", "mailto:"].includes(u.protocol) ? u.toString() : null;
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

/** Річна сума лише в правдоподібних межах: 1 000 у кеші NextRole це заглушка, а не зарплата. */
const MIN_ANNUAL = 10_000;
const MAX_ANNUAL = 5_000_000;
const plausibleAnnual = (v: number): boolean => v >= MIN_ANNUAL && v <= MAX_ANNUAL;

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

/** Місце вакансії компанії, як у engine (companyJob): «Remote», «Lisbon», «Remote or Lisbon». */
export function companyJobLocation(remoteMode: string, city: string | null): string | null {
  const modes = remoteMode.split(",").map((m) => m.trim());
  const place = modes.includes("city") ? city?.trim() || null : null;
  return [modes.includes("remote") ? "Remote" : null, place].filter(Boolean).join(" or ") || null;
}
