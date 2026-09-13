// Місце вакансії: копія частини engine/src/digest/match.ts (від foldText до isRemoteLocation).
//
// search_jobs (lib/crm/public-jobs.ts) вирішує «віддалено» і «це місто» так само, як
// добірка engine. Код нижче дослівно такий самий, як в engine між цими двома функціями;
// тест nextrole-parity.test.ts це звіряє. Правити engine, потім переносити сюди.

/** Нижній регістр без діакритики й розділових знаків: «São Paulo» → «sao paulo». */
export function foldText(s: string): string {
  return s.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** Інші назви того самого міста, що трапляються в локаціях вакансій. */
const CITY_ALIASES: Record<string, string[]> = {
  "new york": ["nyc", "new york city", "manhattan", "brooklyn"],
  "san francisco": ["sf", "bay area", "san francisco bay area"],
  "los angeles": ["la"],
  kyiv: ["kiev"],
  munich: ["munchen", "muenchen"],
  lisbon: ["lisboa"],
  prague: ["praha"],
  warsaw: ["warszawa"],
  vienna: ["wien"],
  zurich: ["zuerich"],
  cologne: ["koln", "koeln"],
  bengaluru: ["bangalore"],
  "hong kong": ["hk"],
  "ho chi minh city": ["ho chi minh", "saigon", "hcmc"],
  "mexico city": ["cdmx", "ciudad de mexico"],
};

/** Усі написання міста людини, згорнуті foldText. */
export function cityVariants(city: string): string[] {
  // «Paris, France» → «paris»: людина могла дописати країну.
  const base = foldText(city.split(",")[0] ?? "");
  if (!base) return [];
  const out = new Set([base]);
  for (const [canon, aliases] of Object.entries(CITY_ALIASES)) {
    if (canon === base || aliases.includes(base)) { out.add(canon); for (const a of aliases) out.add(a); }
  }
  return [...out];
}

/** Чи згадує текст локації місто цілим словом (без регістру й діакритики). */
export function mentionsCity(text: string | null, city: string | null): boolean {
  if (!text || !city) return false;
  const hay = ` ${foldText(text)} `;
  return cityVariants(city).some((v) => hay.includes(` ${v} `));
}

const REMOTE_WORDS = /\b(remote|anywhere|worldwide|work from home|wfh|distributed|fully remote)\b/i;
const OFFICE_WORDS = /\b(hybrid|on-?site|in-?office|office based|office-based)\b/i;

/**
 * Віддалена вакансія NextRole: прапорець джерела або слова в локації. «Hybrid» чи
 * «On-site» без слова «remote» перемагають прапорець: 12.09 у кеші був
 * remote = 1 з локацією «New York - Hybrid».
 */
export function isRemoteLocation(remoteFlag: boolean, location: string | null): boolean {
  const text = location ?? "";
  if (OFFICE_WORDS.test(text) && !/\bremote\b/i.test(text)) return false;
  return remoteFlag || REMOTE_WORDS.test(text);
}
