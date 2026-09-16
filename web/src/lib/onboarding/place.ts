// «Where do you want to work?»: віддалено, місто чи обидва, і за бажанням
// найменша зарплата. Розбір форми в поля users (remote_mode, city,
// salary_min, salary_currency).

export const CURRENCIES = ["USD", "EUR", "GBP"] as const;
export type Currency = (typeof CURRENCIES)[number];
export type WhereChoice = "remote" | "city" | "both";

export type Place = {
  /** Формат users.remote_mode: 'remote' | 'city' | 'remote,city'. */
  remoteMode: "remote" | "city" | "remote,city";
  city: string | null;
  salaryMin: number | null;
  salaryCurrency: Currency | null;
};

export type PlaceErrors = Partial<Record<"where" | "city" | "salary", string>>;

export const SALARY_MAX = 10_000_000;
const CITY = /^[\p{L}\p{M}][\p{L}\p{M} .,'’()-]{0,79}$/u;

const MODE: Record<WhereChoice, Place["remoteMode"]> = { remote: "remote", city: "city", both: "remote,city" };

/** Назад з бази у вибір форми. */
export function whereFromMode(mode: string | null | undefined): WhereChoice | null {
  if (mode === "remote") return "remote";
  if (mode === "city") return "city";
  if (mode === "remote,city") return "both";
  return null;
}

/** «120000», «120 000», «120,000», «120k» → 120000. Порожнє → null. */
export function parseSalary(raw: string): number | null | "invalid" {
  const s = raw.trim().toLowerCase().replace(/[\s,_'’]/g, "");
  if (!s) return null;
  const m = /^(\d+(?:\.\d+)?)(k)?$/.exec(s);
  if (!m) return "invalid";
  const n = Math.round(Number(m[1]) * (m[2] ? 1000 : 1));
  if (!Number.isFinite(n) || n < 1 || n > SALARY_MAX) return "invalid";
  return n;
}

export function parsePlace(form: {
  where: unknown;
  city: unknown;
  salary: unknown;
  currency: unknown;
}): { ok: true; place: Place } | { ok: false; errors: PlaceErrors } {
  const errors: PlaceErrors = {};
  // Object.hasOwn, а не `in`: інакше «toString» чи «constructor» з форми пройшли б як вибір.
  const where = typeof form.where === "string" && Object.hasOwn(MODE, form.where) ? (form.where as WhereChoice) : null;
  if (!where) errors.where = "Choose remote, a city or both.";

  const cityRaw = typeof form.city === "string" ? form.city.trim().replace(/\s+/g, " ") : "";
  const needsCity = where === "city" || where === "both";
  if (needsCity && !cityRaw) errors.city = "Enter the city.";
  else if (needsCity && !CITY.test(cityRaw)) errors.city = "Use the city name, for example Lisbon.";

  const salary = parseSalary(typeof form.salary === "string" ? form.salary : "");
  if (salary === "invalid") errors.salary = "Enter a whole number, for example 90000 or 90k.";

  const currency = CURRENCIES.find((c) => c === form.currency) ?? "USD";
  if (Object.keys(errors).length > 0 || !where || salary === "invalid") return { ok: false, errors };
  return {
    ok: true,
    place: {
      remoteMode: MODE[where],
      city: needsCity ? cityRaw : null,
      salaryMin: salary,
      salaryCurrency: salary === null ? null : currency,
    },
  };
}

/** Що вдалося взяти зі слів людини (крок 1) для кроку місця. */
export type PlaceGuess = { where: WhereChoice | null; salary: number | null; currency: Currency | null };

const REMOTE_WORDS = /(?<![\p{L}])(remote(ly)?|anywhere|worldwide|віддален\p{L}*|дистанційн\p{L}*|удал[её]нн?\p{L}*|дистанционн\p{L}*)(?![\p{L}])/iu;
const CURRENCY_OF: Record<string, Currency> = {
  $: "USD", usd: "USD", usdc: "USD", usdt: "USD", dollar: "USD", dollars: "USD", "доларів": "USD", "долларов": "USD",
  "€": "EUR", eur: "EUR", euro: "EUR", euros: "EUR", "євро": "EUR", "евро": "EUR",
  "£": "GBP", gbp: "GBP", pounds: "GBP",
};
const CUR = "(\\$|€|£|usdc|usdt|usd|eur|gbp|euros?|dollars?|pounds|євро|евро|доларів|долларов)";
const NUM = "(\\d{1,3}(?:[ ,.’']\\d{3})+|\\d+(?:[.,]\\d+)?)\\s*(k)?";
const SALARY_RE = new RegExp(`(?:${CUR}\\s*${NUM}|${NUM}\\s*${CUR})`, "iu");
const MONTH = /^[\s,]*(a|per|\/|в|на)?\s*(month|mo|monthly|місяць|месяц)/iu;
const MONTHLY_WORD = /^[\s,]*monthly/iu;

/** Число без валюти: «120000», «120 000», «120k». Шукаємо всі, беремо перше, схоже на зарплату. */
const BARE_NUM_RE = new RegExp(`(?<![\\p{L}\\d$€£])${NUM}(?![\\p{L}\\d])`, "giu");
/** Слова, після яких число це не гроші: «20 partnerships», «5 років», «3000 followers». */
const NOT_MONEY_AFTER =
  /^[\s,]*(%|x\b|partnership|project|year|month\w*\s+of|people|users?|followers?|subscribers?|stars?|commits?|prs?\b|pull|tx\b|transactions?|hours?|днів|дні|рок\p{L}*|років|люд\p{L}*|підписник\p{L}*|проєкт\p{L}*|проект\p{L}*)/iu;
/** Найменша річна сума, яку читаємо як зарплату з голого числа: нижче це радше рік, вік чи лічилка. */
const BARE_YEARLY_MIN = 10_000;
/** Найменша місячна сума, коли поруч сказано «a month»: 1 000 на місяць це 12 000 на рік. */
const BARE_MONTHLY_MIN = 500;

/** Голе число зарплатою (п.1 раунду 6, власник: «я долар не поставив, просто цифру написав»). */
function bareSalary(text: string): number | null {
  BARE_NUM_RE.lastIndex = 0;
  for (let m = BARE_NUM_RE.exec(text); m; m = BARE_NUM_RE.exec(text)) {
    const raw = m[1] ?? "";
    const k = Boolean(m[2]);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 24);
    if (NOT_MONEY_AFTER.test(after)) continue;
    const grouped = /^\d{1,3}(?:[ ,.’']\d{3})+$/.test(raw);
    const base = Number(grouped ? raw.replace(/[ ,.’']/g, "") : raw.replace(",", "."));
    if (!Number.isFinite(base)) continue;
    const monthly = MONTH.test(after) || MONTHLY_WORD.test(after);
    const amount = Math.round(base * (k ? 1000 : 1) * (monthly ? 12 : 1));
    const floor = monthly ? BARE_MONTHLY_MIN * 12 : BARE_YEARLY_MIN;
    // Рік («in 2024») сам по собі не зарплата: його рятує лише роздільник тисяч, «k» чи «a month».
    const yearLike = !grouped && !k && !monthly && base >= 1900 && base <= 2100;
    if (yearLike || amount < floor || amount > SALARY_MAX) continue;
    return amount;
  }
  return null;
}

/**
 * «BD lead, remote, from 3,000 EUR a month» → віддалено й 36 000 EUR на рік. Місто не вгадуємо.
 * Число без валюти теж беремо (власник писав суму самою цифрою), але лише схоже на зарплату:
 * від 10 000 на рік, або з «k», або з роздільником тисяч, або сказано «a month». Валюта тоді USD,
 * як за замовчуванням у формі. Людина бачить підставлене і править.
 */
export function placeFromText(text: string): PlaceGuess {
  const where = REMOTE_WORDS.test(text) ? "remote" : null;
  const m = SALARY_RE.exec(text);
  if (!m) {
    const bare = bareSalary(text);
    return { where, salary: bare, currency: bare === null ? null : "USD" };
  }
  const cur = (m[1] ?? m[6] ?? "").toLowerCase();
  const rawNum = m[2] ?? m[4] ?? "";
  const k = Boolean(m[3] ?? m[5]);
  // «3,000» і «3.000» це тисячі; «3.5k» це 3 500.
  const grouped = /^\d{1,3}(?:[ ,.’']\d{3})+$/.test(rawNum);
  const base = Number(grouped ? rawNum.replace(/[ ,.’']/g, "") : rawNum.replace(",", "."));
  let amount = Math.round(base * (k ? 1000 : 1));
  const after = text.slice(m.index + m[0].length, m.index + m[0].length + 20);
  if (MONTH.test(after) || MONTHLY_WORD.test(after)) amount *= 12;
  const currency = CURRENCY_OF[cur] ?? null;
  if (!currency || !Number.isFinite(amount) || amount < 1000 || amount > SALARY_MAX) return { where, salary: null, currency: null };
  return { where, salary: amount, currency };
}
