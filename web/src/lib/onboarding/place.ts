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
  const where = typeof form.where === "string" && form.where in MODE ? (form.where as WhereChoice) : null;
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
