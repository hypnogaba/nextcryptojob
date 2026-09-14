// Чистка вакансій зі сканування: копія engine/src/digest/clean.ts.
//
// Сканер engine уже відкидає ці компанії при записі в базу вакансій, а search_jobs
// (lib/crm/public-jobs.ts) перевіряє ще раз тими самими правилами, що й добірка. Код нижче
// першого export дослівно такий самий, як в engine; тест parity.test.ts це звіряє.

/**
 * Компанії, що потрапили під тег web3, але не крипто. Ключ = jobs_cache.company_key
 * (нижній регістр, без юридичного суфікса). Список з живого кешу 12.09; сумнівні
 * (біржові брокери з криптою, трейдингові фірми з крипто-столом) не додавали.
 */
export const NON_CRYPTO_COMPANIES: ReadonlySet<string> = new Set([
  "perle", "crusoe", "ping identity", "zscaler", "sophos", "notion", "ashby", "zinnia", "inmobi", "virtuozzo",
  "givedirectly", "fuse energy", "dynamo ai", "discord", "stockx", "str", "blackrock", "wave mobile money",
  "lunar a s", "funding circle", "shippo", "cyberhaven", "integra", "current mobile", "immuta", "greenhouse",
  "branch", "cross river", "auxmoney", "clue", "masterclass", "axiom", "launchpadtechnologiesinc", "stash",
  "transmit security", "sift", "cls", "groma", "webai", "hyperbolic", "hyperbolic labs", "wealthsimple",
  "bcg attorney search",
  // 14.09: дошка Bitkraft на Getro каже «крипто», але вакансії Highrise без жодного слова про крипту.
  "pocket worlds",
]);

/** Ключ компанії для порівнянь: нижній регістр, лише літери й цифри через пробіл. */
export function companyKey(name: string): string {
  return name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&amp;/g, "&")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\b(inc|llc|ltd|limited|gmbh|ag|sa|pte|plc|corp|corporation|co|bv|oy|ab|srl)\b/g, " ")
    .replace(/\s+/g, " ").trim();
}

export function isNonCryptoCompany(key: string | null | undefined, name?: string | null): boolean {
  if (key && NON_CRYPTO_COMPANIES.has(key.trim().toLowerCase())) return true;
  return !!name && NON_CRYPTO_COMPANIES.has(companyKey(name));
}
