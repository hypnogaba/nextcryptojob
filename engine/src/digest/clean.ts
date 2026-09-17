// Чистка вакансій перед добіркою.
//
// Сканер (src/jobs) бере лише крипто-джерела й уже відкидає компанії з цього списку при записі;
// добірка й сайт перевіряють ще раз, бо список міняється швидше, ніж старі рядки виходять з бази.
// Список складено 12.09 на живому кеші попереднього проєкту (тоді вакансії читались звідти): серед свіжих
// вакансій з тегом web3 були розшифровувачі аудіо (Perle), будівельники центрів обробки даних
// (Crusoe), страхування, безпека пошти й мереж. Три сита, всі детерміновані:
// 1) тег web3 (у SQL, jobs.ts), 2) компанія не з цього списку,
// 3) назва мапиться на нашу роль і не з переліку не-крипто назв (roles.ts).

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

/**
 * Слова, що позначають той самий бренд під іншою юридичною формою, не просто суфікс на кшталт
 * Inc/Ltd, а ціле окреме слово: «Morpho» і «Morpho Labs», «Offchain» і «Offchain Labs», одна
 * компанія (власник 15.09: «Account Growth, Morpho, Paris» і «Account Growth, Morpho Labs, Paris»
 * поруч, «погане лице»). Навмисно вужчий список, ніж discover.ts looseKey (там ще protocol/network
 * і подібне, для іншої мети, чи заводити нову дошку ATS): тут лише слова, які власник назвав
 * напряму, щоб не злити «Acme Protocol» з «Acme» чи «Solana Foundation» з «Solana Labs» (різні
 * організації).
 */
const COMPANY_ALIAS_WORDS = new Set(["labs", "lab", "foundation"]);

/**
 * companyKey без слів-псевдонімів бренду: «Morpho» і «Morpho Labs» дають один ключ. Для дедупу
 * вакансій (jobs/ids.ts dedupeKey, jobs/prepare.ts company_key і добірка/сайт/лист/бот через той
 * самий стовпець), не для companyKey самого: NON_CRYPTO_COMPANIES і решта точних звірянь лишаються
 * на companyKey.
 */
export function brandKey(name: string): string {
  const words = companyKey(name).split(" ").filter(Boolean);
  const core = words.filter((w) => !COMPANY_ALIAS_WORDS.has(w));
  return (core.length ? core : words).join(" ");
}
