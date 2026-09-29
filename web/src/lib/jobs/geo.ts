// Країна, регіон і пояс людини та обмеження віддаленої вакансії: копія engine/src/digest/geo.ts.
//
// Сторінка /jobs підбирає тими самими правилами, що й щоденна добірка engine. Worker сайту не збирає код
// engine, тож код нижче першого export дослівно такий самий, як в engine; тест parity.test.ts це звіряє.
// Правити engine, потім переносити сюди.

export type Region = "NA" | "SA" | "EU" | "ME" | "AF" | "APAC";

/** Де людина: країна (ISO 3166-1 alpha-2), регіон і зсув поясу від UTC у годинах. Кожне поле може бути null. */
export interface PersonGeo {
  country: string | null;
  region: Region | null;
  offsetHours: number | null;
}

export const UNKNOWN_GEO: PersonGeo = { country: null, region: null, offsetHours: null };

/** Що вакансія дозволяє: людина мусить підпадати під країну, регіон або вікно поясів. Порожня частина = не обмежує. */
export interface Restriction {
  countries: ReadonlySet<string>;
  regions: ReadonlySet<Region>;
  /** Вікно зсуву від UTC, години включно; null = вікна немає. */
  window: { lo: number; hi: number } | null;
}

// ---------------- країни ----------------

const COUNTRY_REGION: Record<string, Region> = {
  US: "NA", CA: "NA", MX: "NA", GT: "NA", CR: "NA", PA: "NA", SV: "NA", HN: "NA", NI: "NA", DO: "NA", PR: "NA", JM: "NA",
  BR: "SA", AR: "SA", CO: "SA", PE: "SA", CL: "SA", UY: "SA", EC: "SA", VE: "SA", BO: "SA", PY: "SA",
  GB: "EU", IE: "EU", FR: "EU", DE: "EU", ES: "EU", PT: "EU", IT: "EU", NL: "EU", BE: "EU", LU: "EU", CH: "EU", AT: "EU",
  PL: "EU", CZ: "EU", SK: "EU", HU: "EU", RO: "EU", BG: "EU", GR: "EU", HR: "EU", SI: "EU", RS: "EU", UA: "EU", EE: "EU",
  LV: "EU", LT: "EU", FI: "EU", SE: "EU", NO: "EU", DK: "EU", IS: "EU", MT: "EU", CY: "EU", TR: "EU", GE: "EU", AM: "EU",
  AE: "ME", SA: "ME", IL: "ME", QA: "ME", KW: "ME", BH: "ME", OM: "ME", JO: "ME", LB: "ME", IR: "ME", IQ: "ME",
  NG: "AF", ZA: "AF", EG: "AF", KE: "AF", MA: "AF", GH: "AF", TN: "AF", ET: "AF", TZ: "AF", UG: "AF",
  SG: "APAC", JP: "APAC", KR: "APAC", IN: "APAC", HK: "APAC", CN: "APAC", TH: "APAC", ID: "APAC", PH: "APAC", VN: "APAC",
  PK: "APAC", BD: "APAC", MY: "APAC", TW: "APAC", AU: "APAC", NZ: "APAC", KZ: "APAC", LK: "APAC",
};

const EU27 = new Set(["AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE", "IT", "LV", "LT", "LU", "MT",
  "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE"]);
/** «EU only» у вакансіях зазвичай значить і EEA. */
const EU_EEA = new Set([...EU27, "NO", "IS", "LI"]);
const LATAM = new Set(["MX", "GT", "CR", "PA", "SV", "HN", "NI", "DO", "BR", "AR", "CO", "PE", "CL", "UY", "EC", "VE", "BO", "PY"]);

/** Назви країн у тексті локацій (нижній регістр, без розділових знаків) → код. */
const COUNTRY_NAMES: Record<string, string> = {
  "united states": "US", "united states of america": "US", usa: "US",
  canada: "CA", mexico: "MX", brazil: "BR", brasil: "BR", argentina: "AR", colombia: "CO", chile: "CL", peru: "PE",
  "united kingdom": "GB", uk: "GB", england: "GB", scotland: "GB", "great britain": "GB", ireland: "IE",
  france: "FR", germany: "DE", deutschland: "DE", spain: "ES", portugal: "PT", italy: "IT", netherlands: "NL", "the netherlands": "NL",
  holland: "NL", belgium: "BE", luxembourg: "LU", switzerland: "CH", austria: "AT", poland: "PL", czechia: "CZ", "czech republic": "CZ",
  slovakia: "SK", hungary: "HU", romania: "RO", bulgaria: "BG", greece: "GR", croatia: "HR", slovenia: "SI", serbia: "RS",
  ukraine: "UA", estonia: "EE", latvia: "LV", lithuania: "LT", finland: "FI", sweden: "SE", norway: "NO", denmark: "DK",
  iceland: "IS", malta: "MT", cyprus: "CY", turkey: "TR", turkiye: "TR", armenia: "AM",
  uae: "AE", "united arab emirates": "AE", "saudi arabia": "SA", israel: "IL", qatar: "QA",
  nigeria: "NG", "south africa": "ZA", egypt: "EG", kenya: "KE", morocco: "MA", ghana: "GH",
  singapore: "SG", japan: "JP", "south korea": "KR", korea: "KR", india: "IN", "hong kong": "HK", china: "CN", thailand: "TH",
  indonesia: "ID", philippines: "PH", vietnam: "VN", pakistan: "PK", bangladesh: "BD", malaysia: "MY", taiwan: "TW",
  australia: "AU", "new zealand": "NZ", kazakhstan: "KZ",
};
/** Довші назви першими: «south africa» до «africa», «united states» до «united». */
const COUNTRY_NAMES_LONGEST = Object.keys(COUNTRY_NAMES).sort((a, b) => b.length - a.length);

const US_STATES = new Set(["AL", "AK", "AZ", "AR", "CA", "CO", "CT", "FL", "GA", "HI", "ID", "IL", "IN", "IA", "KS", "KY", "LA", "ME",
  "MD", "MA", "MI", "MN", "MS", "MO", "MT", "NE", "NV", "NH", "NJ", "NM", "NY", "NC", "ND", "OH", "OK", "OR", "PA", "RI", "SC", "SD", "TN",
  "TX", "UT", "VT", "VA", "WA", "WV", "WI", "WY", "DC"]);
const US_STATE_NAMES = new Set(["alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut", "delaware", "florida",
  "hawaii", "idaho", "illinois", "indiana", "iowa", "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
  "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new hampshire", "new jersey", "new mexico", "new york",
  "north carolina", "north dakota", "ohio", "oklahoma", "oregon", "pennsylvania", "rhode island", "south carolina", "south dakota",
  "tennessee", "texas", "utah", "vermont", "virginia", "washington", "west virginia", "wisconsin", "wyoming"]);
// Без NL, SK, PE: це Нідерланди, Словаччина, Перу у форматі «Amsterdam, NL».
const CA_PROVINCES = new Set(["ON", "BC", "AB", "QC", "MB", "NS", "NB"]);
const CA_PROVINCE_NAMES = new Set(["ontario", "british columbia", "alberta", "quebec", "manitoba", "saskatchewan", "nova scotia"]);

const fold = (s: string): string =>
  s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** Країна, названа в тексті локації («Paris, Texas» → US, «Toronto, ON» → CA, «Berlin, Germany» → DE); null, якщо не названа. */
export function countryInText(text: string | null | undefined): string | null {
  if (!text) return null;
  // Двобуквений код після коми чи в дужках: «Austin, TX», «Toronto, ON»; лише великі літери.
  for (const m of text.matchAll(/[,(]\s*([A-Z]{2})\b/g)) {
    const code = m[1]!;
    if (US_STATES.has(code)) return "US";
    if (CA_PROVINCES.has(code)) return "CA";
  }
  const hay = ` ${fold(text)} `;
  for (const name of COUNTRY_NAMES_LONGEST) {
    if (hay.includes(` ${name} `)) return COUNTRY_NAMES[name]!;
  }
  for (const s of US_STATE_NAMES) if (hay.includes(` ${s} `)) return "US";
  for (const s of CA_PROVINCE_NAMES) if (hay.includes(` ${s} `)) return "CA";
  return null;
}

// ---------------- людина ----------------

/** Країна за поясом IANA, коли пояс її однозначно каже. */
const TZ_COUNTRY: Record<string, string> = {
  "America/New_York": "US", "America/Chicago": "US", "America/Denver": "US", "America/Los_Angeles": "US", "America/Phoenix": "US",
  "America/Anchorage": "US", "America/Detroit": "US", "America/Boise": "US", "America/Juneau": "US", "Pacific/Honolulu": "US",
  "America/Adak": "US", "America/Puerto_Rico": "PR",
  "America/Toronto": "CA", "America/Vancouver": "CA", "America/Edmonton": "CA", "America/Winnipeg": "CA", "America/Halifax": "CA",
  "America/St_Johns": "CA", "America/Regina": "CA", "America/Montreal": "CA",
  "America/Mexico_City": "MX", "America/Monterrey": "MX", "America/Cancun": "MX", "America/Tijuana": "MX",
  "America/Sao_Paulo": "BR", "America/Bahia": "BR", "America/Fortaleza": "BR", "America/Manaus": "BR", "America/Recife": "BR",
  "America/Argentina/Buenos_Aires": "AR", "America/Buenos_Aires": "AR", "America/Bogota": "CO", "America/Lima": "PE",
  "America/Santiago": "CL", "America/Montevideo": "UY", "America/Guayaquil": "EC", "America/Caracas": "VE", "America/La_Paz": "BO",
  "America/Asuncion": "PY", "America/Guatemala": "GT", "America/Costa_Rica": "CR", "America/Panama": "PA",
  "America/El_Salvador": "SV", "America/Tegucigalpa": "HN", "America/Managua": "NI", "America/Santo_Domingo": "DO",
  "America/Jamaica": "JM",
  "Europe/London": "GB", "Europe/Belfast": "GB", "Europe/Dublin": "IE", "Europe/Paris": "FR", "Europe/Berlin": "DE",
  "Europe/Madrid": "ES", "Europe/Lisbon": "PT", "Europe/Rome": "IT", "Europe/Amsterdam": "NL", "Europe/Brussels": "BE",
  "Europe/Luxembourg": "LU", "Europe/Zurich": "CH", "Europe/Vienna": "AT", "Europe/Warsaw": "PL", "Europe/Prague": "CZ",
  "Europe/Bratislava": "SK", "Europe/Budapest": "HU", "Europe/Bucharest": "RO", "Europe/Sofia": "BG", "Europe/Athens": "GR",
  "Europe/Zagreb": "HR", "Europe/Ljubljana": "SI", "Europe/Belgrade": "RS", "Europe/Kyiv": "UA", "Europe/Kiev": "UA",
  "Europe/Tallinn": "EE", "Europe/Riga": "LV", "Europe/Vilnius": "LT", "Europe/Helsinki": "FI", "Europe/Stockholm": "SE",
  "Europe/Oslo": "NO", "Europe/Copenhagen": "DK", "Atlantic/Reykjavik": "IS", "Europe/Malta": "MT", "Asia/Nicosia": "CY",
  "Europe/Istanbul": "TR", "Asia/Istanbul": "TR", "Asia/Tbilisi": "GE", "Asia/Yerevan": "AM",
  "Asia/Dubai": "AE", "Asia/Riyadh": "SA", "Asia/Tel_Aviv": "IL", "Asia/Jerusalem": "IL", "Asia/Qatar": "QA", "Asia/Kuwait": "KW",
  "Asia/Bahrain": "BH", "Asia/Muscat": "OM", "Asia/Amman": "JO", "Asia/Beirut": "LB", "Asia/Tehran": "IR", "Asia/Baghdad": "IQ",
  "Africa/Lagos": "NG", "Africa/Johannesburg": "ZA", "Africa/Cairo": "EG", "Africa/Nairobi": "KE", "Africa/Casablanca": "MA",
  "Africa/Accra": "GH", "Africa/Tunis": "TN", "Africa/Addis_Ababa": "ET", "Africa/Dar_es_Salaam": "TZ", "Africa/Kampala": "UG",
  "Asia/Singapore": "SG", "Asia/Tokyo": "JP", "Asia/Seoul": "KR", "Asia/Kolkata": "IN", "Asia/Calcutta": "IN",
  "Asia/Hong_Kong": "HK", "Asia/Shanghai": "CN", "Asia/Bangkok": "TH", "Asia/Jakarta": "ID", "Asia/Manila": "PH",
  "Asia/Ho_Chi_Minh": "VN", "Asia/Saigon": "VN", "Asia/Karachi": "PK", "Asia/Dhaka": "BD", "Asia/Kuala_Lumpur": "MY",
  "Asia/Taipei": "TW", "Asia/Almaty": "KZ", "Asia/Colombo": "LK", "Pacific/Auckland": "NZ",
  "Australia/Sydney": "AU", "Australia/Melbourne": "AU", "Australia/Brisbane": "AU", "Australia/Perth": "AU",
  "Australia/Adelaide": "AU", "Australia/Hobart": "AU", "Australia/Darwin": "AU",
};

/** Індіана, Кентуккі й Північна Дакота мають вкладені пояси (America/Indiana/Indianapolis): усе це США. */
const US_TZ_PREFIX = /^America\/(Indiana|Kentucky|North_Dakota)\//;

function regionOfZone(tz: string): Region | null {
  const [area, city = ""] = tz.split("/");
  switch (area) {
    case "America": {
      if (US_TZ_PREFIX.test(tz)) return "NA";
      const c = TZ_COUNTRY[tz];
      if (c) return COUNTRY_REGION[c] ?? null;
      // Невідомі міста Америки: за півкулею не вгадуємо, лише відомі південні.
      return /^(Argentina|Sao_Paulo|Bogota|Lima|Santiago|Caracas|La_Paz|Montevideo|Asuncion|Guayaquil)/.test(city) ? "SA" : "NA";
    }
    case "Europe": return "EU";
    case "Africa": return "AF";
    case "Australia": return "APAC";
    case "Pacific": return tz === "Pacific/Honolulu" ? "NA" : "APAC";
    case "Asia": {
      const c = TZ_COUNTRY[tz];
      if (c) return COUNTRY_REGION[c] ?? null;
      return /^(Kabul|Tashkent|Colombo|Kathmandu|Yangon|Rangoon|Phnom_Penh|Vientiane|Brunei|Macau|Ulaanbaatar|Kolkata|Karachi|Dhaka|Thimphu|Makassar|Jayapura|Pontianak|Kuching|Seoul|Pyongyang|Taipei|Manila)/.test(city) ? "APAC" : null;
    }
    case "Atlantic": return tz === "Atlantic/Reykjavik" || tz === "Atlantic/Azores" || tz === "Atlantic/Madeira" || tz === "Atlantic/Canary" ? "EU" : null;
    default: return null;
  }
}

/** Зсув пояси від UTC у годинах на мить `at` («GMT+5:30» → 5.5); null, якщо пояс невідомий. */
export function offsetHours(timezone: string, at: Date): number | null {
  try {
    const part = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "longOffset" })
      .formatToParts(at).find((p) => p.type === "timeZoneName")?.value;
    if (!part) return null;
    if (part === "GMT") return 0;
    const m = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(part);
    if (!m) return null;
    return (m[1] === "-" ? -1 : 1) * (Number(m[2]) + (m[3] ? Number(m[3]) / 60 : 0));
  } catch {
    return null;
  }
}

/**
 * Де людина за її поясом (users.timezone) і, якщо вона дописала країну до міста («Paris, France»), за цим.
 * Порожній чи невпізнаний пояс: усе null, і ніщо не відсіюється. UTC і Etc/* нічого про місце не кажуть.
 */
export function personGeo(timezone: string | null | undefined, city: string | null | undefined, now: Date): PersonGeo {
  const tz = timezone?.trim();
  const cityCountry = city && city.includes(",") ? countryInText(city.slice(city.indexOf(","))) : null;
  if (!tz || /^(UTC|GMT|Etc\/.*|Z)$/i.test(tz)) {
    return cityCountry ? { country: cityCountry, region: COUNTRY_REGION[cityCountry] ?? null, offsetHours: null } : UNKNOWN_GEO;
  }
  const offset = offsetHours(tz, now);
  if (offset === null) return UNKNOWN_GEO;
  const country = cityCountry ?? (US_TZ_PREFIX.test(tz) ? "US" : TZ_COUNTRY[tz] ?? null);
  const region = (country ? COUNTRY_REGION[country] : null) ?? regionOfZone(tz);
  return { country, region: region ?? null, offsetHours: offset };
}

// ---------------- вакансія ----------------

const WORLD = /\b(worldwide|anywhere|global(ly)?|any country|any location|all countries|work from anywhere)\b/i;

const NO_COUNTRIES: ReadonlySet<string> = new Set();
const NO_REGIONS: ReadonlySet<Region> = new Set();

const NAMED: Array<{ re: RegExp; countries?: string[]; regions?: Region[]; explicit?: boolean }> = [
  // Регістр важливий: «US» це країна, «us» це займенник.
  { re: /\b(U\.S\.A?|USA|US|United States(?: of America)?)\b/, countries: ["US"] },
  { re: /\bCanada\b/i, countries: ["CA"] },
  { re: /\b(United Kingdom|UK|Great Britain)\b/, countries: ["GB"] },
  { re: /\bNorth America(?:n)?\b/i, regions: ["NA"] },
  { re: /\bAmericas\b/i, regions: ["NA", "SA"] },
  { re: /\b(LATAM|Latin America)\b/i, countries: [...LATAM] },
  { re: /\bSouth America\b/i, regions: ["SA"] },
  { re: /\bEMEA\b/, regions: ["EU", "ME", "AF"] },
  { re: /\b(European Union|EU\/EEA|EEA)\b/i, countries: [...EU_EEA] },
  { re: /\b(EU|E\.U\.)\b/, countries: [...EU_EEA] },
  { re: /\bEurope(?:an)?\b/i, regions: ["EU"] },
  { re: /\b(APAC|Asia[- ]Pacific|Asia|Oceania|ANZ)\b/i, regions: ["APAC"] },
  { re: /\bMiddle East\b/i, regions: ["ME"] },
  { re: /\bAfrica\b/i, regions: ["AF"] },
];

/** Ознака явного обмеження: «only», «based in», «must be located in», «residents». */
const EXPLICIT = /\b(only|based in|located in|residents?|citizens?|must (?:be|live|reside)|authori[sz]ed to work|work authori[sz]ation|eligible to work)\b/i;

/**
 * Вікно поясів із тексту: «UTC-3 to UTC+2», «GMT+1 - GMT+4», «UTC±2», «within 3 hours of UTC+1», «UTC+2 ± 3».
 * Одне «UTC+2» без діапазону: центр з допуском 2 години. null, якщо вікна в тексті немає.
 */
export function parseWindow(text: string): { lo: number; hi: number } | null {
  const n = (v: string): number => Number(v.replace(/^\+/, ""));
  const range = /(?:UTC|GMT)\s*([+-]\d{1,2})\s*(?:to|-|–|and|through)\s*(?:UTC|GMT)?\s*([+-]\d{1,2})/i.exec(text);
  if (range) {
    const a = n(range[1]!), b = n(range[2]!);
    return { lo: Math.min(a, b), hi: Math.max(a, b) };
  }
  const plusMinus = /(?:UTC|GMT)\s*±\s*(\d{1,2})\b/i.exec(text);
  if (plusMinus) return { lo: -Number(plusMinus[1]), hi: Number(plusMinus[1]) };
  // «3 hours of UTC+1», «+/- 3 hours of UTC+1», «within 3 hours of UTC+1», «UTC+1 +/- 3».
  const around: Array<[RegExp, number, number]> = [
    [/(?:within|\+\/-|±)\s*(\d{1,2})\s*(?:hours?|hrs?|h)?\s*(?:of|from|around)?\s*(?:UTC|GMT)\s*([+-]\d{1,2})\b/i, 1, 2],
    [/(\d{1,2})\s*(?:hours?|hrs?)\s*(?:of|from|around)\s*(?:UTC|GMT)\s*([+-]\d{1,2})\b/i, 1, 2],
    [/(?:UTC|GMT)\s*([+-]\d{1,2})\s*(?:\+\/-|±)\s*(\d{1,2})\b/i, 2, 1],
  ];
  for (const [re, wi, ci] of around) {
    const m = re.exec(text);
    if (m) return { lo: n(m[ci]!) - Number(m[wi]), hi: n(m[ci]!) + Number(m[wi]) };
  }
  const single = /(?:UTC|GMT)\s*([+-]\d{1,2})\b/i.exec(text);
  if (single) return { lo: n(single[1]!) - 2, hi: n(single[1]!) + 2 };
  return null;
}

/**
 * Обмеження віддаленої вакансії з тексту локації (і, лише явні, з назви). null: обмеження немає або ми його
 * не впізнали. «Remote (US)», «Remote, EMEA», «Europe only», «Must be based in Germany», «UTC-3 to UTC+2».
 * Слова «worldwide/anywhere/global» скасовують країни й регіони: «Remote, Global (US preferred)» не обмежена.
 */
export function parseRestriction(location: string | null | undefined, title?: string | null): Restriction | null {
  const countries = new Set<string>();
  const regions = new Set<Region>();
  let window: { lo: number; hi: number } | null = null;

  const scan = (text: string, explicitOnly: boolean): void => {
    if (!text) return;
    const w = parseWindow(text);
    if (w) window = window ?? w;
    if (WORLD.test(text)) return;
    // У назві лише те, що сказано прямо: «Engineer - US only». У локації достатньо назви місця.
    if (explicitOnly && !EXPLICIT.test(text)) return;
    // «must be based in Germany»: країна за назвою, навіть якщо це не в списку явних слів вище.
    const based = /\b(?:must be|based|located|resident|residing|live|living|eligible to work|authori[sz]ed to work)\s+(?:in|within)\s+(?:the\s+)?([A-Za-z .'-]{2,40})/i.exec(text);
    if (based) {
      const c = countryInText(based[1]);
      if (c) countries.add(c);
    }
    for (const n of NAMED) {
      if (!n.re.test(text)) continue;
      for (const c of n.countries ?? []) countries.add(c);
      for (const r of n.regions ?? []) regions.add(r);
    }
  };
  if (location) scan(location, false);
  if (title) scan(title, true);
  if (countries.size === 0 && regions.size === 0 && window === null) return null;
  return { countries: countries.size ? countries : NO_COUNTRIES, regions: regions.size ? regions : NO_REGIONS, window };
}

/**
 * Чи підходить людина під обмеження: true підходить, false ні (обидва боки відомі і не сходяться),
 * null не знаємо (людину не вдалося розпізнати за поясом).
 */
export function fitsRestriction(r: Restriction, person: PersonGeo): boolean | null {
  const known = person.country !== null || person.region !== null || person.offsetHours !== null;
  if (!known) return null;
  let verdict: boolean | null = null;
  if (r.countries.size > 0 || r.regions.size > 0) {
    if (person.country !== null && r.countries.has(person.country)) verdict = true;
    else if (person.region !== null && r.regions.has(person.region)) verdict = true;
    else if (r.countries.size > 0 && r.regions.size === 0 && person.country === null) {
      // Лише країни, а країну людини не знаємо: за регіоном можна лише спростувати («US only» і Європа).
      const regionsOfCountries = new Set([...r.countries].map((c) => COUNTRY_REGION[c]).filter(Boolean));
      verdict = person.region !== null && !regionsOfCountries.has(person.region) ? false : null;
    } else if (person.country !== null || person.region !== null) verdict = false;
  }
  if (verdict !== false && r.window && person.offsetHours !== null) {
    const inside = person.offsetHours >= r.window.lo && person.offsetHours <= r.window.hi;
    if (!inside) verdict = false;
    else if (verdict === null) verdict = true;
  }
  return verdict;
}

/**
 * Чи міста в локації вакансії й людини це те саме місце по країні («Paris» і «Paris, Texas»). false лише
 * коли країна названа з обох боків і різна; немає країни з одного боку: true, бо перевірити нема чим.
 */
export function sameCountry(jobPlaceText: string | null | undefined, personCountry: string | null): boolean {
  if (!personCountry) return true;
  const jobCountry = countryInText(jobPlaceText);
  return jobCountry === null || jobCountry === personCountry;
}
