// Перенесено з NextRole (crypto-jobs-agent, scanner): src/salary.ts, без змін у правилах.
/**
 * Вилка з тексту оголошення. Без моделі, без мережі.
 *
 * Лише 226 з 18 767 рядків кешу мають salary_min: ATS майже ніколи не
 * віддають вилку окремим полем, зате пишуть її в текст: «$120,000 -
 * $150,000», «€60.000 – €80.000», «60k-80k EUR». Цей модуль ловить саме такі
 * записи і повертає числа, які далі йдуть у jobs_cache і в картку.
 *
 * Правила, кожне з реального тексту:
 * - число без валюти поруч не зарплата (роки «2024–2026», «401(k)»,
 *   «24/7», «5 years»);
 * - відсотки й equity ні;
 * - «per hour» пропускаємо: у річну шкалу без припущень не перевести;
 * - «per month», «par mois», «в місяць» множимо на 12, бо картка й
 *   профіль порівнюють річні числа;
 * - вилка важливіша за одиночну суму: якщо є обидві, беремо вилку.
 */
export interface Salary {
  min: number | null;
  max: number | null;
  currency: string;
}

/** Символи й коди валют → ISO-код. Довші варіанти стоять раніше за коротші. */
const SYMBOLS: Array<[RegExp, string]> = [
  [/^(?:US\$|USD)/i, "USD"], [/^(?:CA\$|C\$|CAD)/i, "CAD"], [/^(?:A\$|AU\$|AUD)/i, "AUD"],
  [/^(?:NZ\$|NZD)/i, "NZD"], [/^(?:S\$|SGD)/i, "SGD"], [/^(?:HK\$|HKD)/i, "HKD"],
  [/^\$/, "USD"], [/^(?:€|EUR)/i, "EUR"], [/^(?:£|GBP)/i, "GBP"], [/^CHF/i, "CHF"],
  [/^(?:zł|PLN)/i, "PLN"], [/^(?:₴|грн|UAH)/i, "UAH"], [/^(?:₽|руб|RUB)/i, "RUB"],
  [/^(?:₹|INR)/i, "INR"], [/^(?:¥|JPY)/i, "JPY"], [/^SEK/i, "SEK"], [/^NOK/i, "NOK"],
  [/^DKK/i, "DKK"], [/^CZK/i, "CZK"], [/^HUF/i, "HUF"], [/^BRL/i, "BRL"], [/^MXN/i, "MXN"],
  [/^AED/i, "AED"],
];

const CUR = String.raw`(?:US\$|CA\$|AU\$|NZ\$|HK\$|[ACS]\$|[$€£₴₽₹¥]|zł|грн|руб|(?<![A-Za-z])(?:USD|EUR|GBP|CHF|CAD|AUD|NZD|SGD|HKD|PLN|UAH|RUB|INR|JPY|SEK|NOK|DKK|CZK|HUF|BRL|MXN|AED)(?![A-Za-z]))`;

/** «120,000», «60.000», «90 000», «120k», «1.5k», «45.50». */
const NUM = String.raw`(\d{1,3}(?:[ ,.'  ]\d{3})+|\d+(?:[.,]\d{1,2})?)`;

const TOKEN = new RegExp(
  String.raw`(?:(${CUR})\s?)?(?<![\w.,/])${NUM}(?:\s?(k|K|тис\.?)(?![A-Za-z]))?(?:\s?(${CUR}))?`,
  "gu",
);

const RANGE_SEP = /^\s*(?:-|–|\u2014|to|à|до|and|et|und|і|и|\.{2,3})\s*$/i;
const HOURLY = /\b(?:per|an|\/)\s?(?:hour|hr|h)\b|hourly|de l'heure|par heure|на годину|в час|в год(?:ину)?\b|per day|daily|par jour|на день/i;
const MONTHLY = /\b(?:per|a|\/)\s?(?:month|mo)\b|monthly|par mois|mensuel|\bmois\b|в місяць|на місяць|щомісяч|в месяц|ежемесяч|міс\.|мес\./i;
const UP_TO = /(?:up to|jusqu'?à|до|until|max(?:imum)?\.?)\s*$/i;
/** Гроші, але не зарплата: бонус, бюджет, раунд інвестицій, виторг. */
const NOT_SALARY = /bonus|sign[- ]?on|stipend|budget|allowance|reimburs|\bARR\b|revenue|raised|funding|valuation|million|billion|users|customers|бонус|бюджет/i;

interface Token {
  value: number; hasK: boolean; currency: string | null;
  start: number; end: number; pct: boolean;
}

const codeOf = (raw: string | undefined): string | null => {
  if (!raw) return null;
  for (const [re, code] of SYMBOLS) if (re.test(raw)) return code;
  return null;
};

function parseNumber(raw: string, hasK: boolean): number {
  const grouped = /^\d{1,3}(?:[ ,.'  ]\d{3})+$/.test(raw);
  // «60.000» без k це тисячі; «1.5k» дробове.
  if (grouped && !hasK) return Number(raw.replace(/[ ,.'  ]/g, ""));
  const n = Number(raw.replace(/[   ']/g, "").replace(",", "."));
  return hasK ? n * 1000 : n;
}

function tokens(text: string): Token[] {
  const out: Token[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const [, pre, num, k, post] = m;
    const hasK = Boolean(k);
    const value = parseNumber(num!, hasK);
    if (!Number.isFinite(value)) continue;
    const end = m.index + m[0].length;
    out.push({
      value, hasK, currency: codeOf(pre) ?? codeOf(post),
      start: m.index, end,
      pct: /^\s?%/.test(text.slice(end, end + 3)),
    });
  }
  return out;
}

const MIN_YEARLY = 1_000;
const MAX_YEARLY = 5_000_000;

/** Період за словами навколо суми: null: не зарплата або година/день, 12: місяць, 1: рік. */
function periodFactor(text: string, start: number, end: number): number | null {
  // Вікно в межах речення: «$1,500 stipend. Base: $100k…» не має
  // отруювати сусідню вилку словом із попередньої фрази.
  const after = text.slice(end, end + 40).split(/[.!?;\n](?=\s|$)/)[0]!;
  const before = text.slice(Math.max(0, start - 40), start).split(/[.!?;\n](?=\s|$)/).pop()!;
  if (NOT_SALARY.test(after) || NOT_SALARY.test(before)) return null;
  if (HOURLY.test(after) || HOURLY.test(before)) return null;
  if (MONTHLY.test(after) || MONTHLY.test(before)) return 12;
  return 1;
}

const yearly = (v: number, factor: number): number | null => {
  const n = Math.round(v * factor);
  return n >= MIN_YEARLY && n <= MAX_YEARLY ? n : null;
};

export function extractSalary(text: string | null | undefined): Salary | null {
  if (!text) return null;
  const t = text.replace(/ | /g, " ");
  const ts = tokens(t).filter((x) => !x.pct);

  // 1. Вилка: два сусідні числа через тире або «to», і бодай одна валюта.
  for (let i = 0; i + 1 < ts.length; i++) {
    const a = ts[i]!, b = ts[i + 1]!;
    if (!RANGE_SEP.test(t.slice(a.end, b.start))) continue;
    const currency = a.currency ?? b.currency;
    if (!currency) continue;
    // «60-80k»: k на другому числі стосується обох.
    const av = !a.hasK && b.hasK && a.value < 1000 ? a.value * 1000 : a.value;
    const factor = periodFactor(t, a.start, b.end);
    if (factor === null) continue;
    const lo = yearly(Math.min(av, b.value), factor);
    const hi = yearly(Math.max(av, b.value), factor);
    if (lo === null || hi === null) continue;
    return { min: lo, max: hi, currency };
  }

  // 2. Одиночна сума з валютою. «up to» робить її стелею, інакше підлогою.
  for (const x of ts) {
    if (!x.currency) continue;
    const factor = periodFactor(t, x.start, x.end);
    if (factor === null) continue;
    const v = yearly(x.value, factor);
    if (v === null) continue;
    const upTo = UP_TO.test(t.slice(Math.max(0, x.start - 12), x.start));
    return upTo ? { min: null, max: v, currency: x.currency } : { min: v, max: null, currency: x.currency };
  }
  return null;
}
