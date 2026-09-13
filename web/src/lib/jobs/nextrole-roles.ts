// Роль вакансії з її назви (і тегів NextRole): копія engine/src/digest/roles.ts.
//
// search_jobs (lib/crm/public-jobs.ts) відсіює вакансії NextRole тими самими правилами,
// що й добірка engine: вакансія без нашої ролі в назві чи з не-крипто назвою не йде
// ні в добірку, ні в пошук. Код нижче першого export дослівно такий самий, як в engine;
// тест nextrole-parity.test.ts це звіряє. Правити engine, потім переносити сюди.
import type { RoleKey } from "@/lib/card/roles";

export const ROLE_ORDER: readonly RoleKey[] = [
  "engineer", "security_auditor", "devrel", "data_research", "product_manager", "bd", "marketing_content",
  "creator_kol", "community", "trader", "designer", "operations_support", "finance", "legal_compliance", "hr_recruiting",
];

/** Назви ролей в інтерфейсі (договір §1). */
export const ROLE_NAMES: Record<RoleKey, string> = {
  engineer: "Engineer",
  security_auditor: "Security auditor",
  devrel: "DevRel",
  data_research: "Data & research",
  product_manager: "Product / project manager",
  bd: "BD & partnerships",
  marketing_content: "Marketing & content",
  creator_kol: "Creator / KOL",
  community: "Community",
  trader: "Trader",
  designer: "Designer",
  operations_support: "Operations & support",
  finance: "Finance",
  legal_compliance: "Legal & compliance",
  hr_recruiting: "HR & recruiting",
};

export const isRoleKey = (v: unknown): v is RoleKey => typeof v === "string" && Object.hasOwn(ROLE_NAMES, v);

/** Ролі з JSON (users.roles, company_jobs.roles): лише відомі ключі, без повторів, у порядку запису. */
export function parseRoles(json: string | null | undefined): RoleKey[] {
  let raw: unknown;
  try { raw = JSON.parse(json ?? "[]"); } catch { return []; }
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter(isRoleKey))];
}

/**
 * Термін: `слово` збігається лише цілим словом, `основа*` з будь-яким
 * закінченням. Вага: 3 сильна ознака ролі, 2 звичайна, 1 слабка.
 */
type Term = [term: string, weight: number];

// ---- Перенесено з web/src/lib/roles/suggest.ts (без змін) ----
const TERMS: Record<RoleKey, Term[]> = {
  engineer: [
    ["smart contract*", 3], ["solidity", 3], ["rust", 3], ["vyper", 3],
    ["engineer*", 2], ["developer*", 2], ["dev", 2], ["devs", 2], ["programmer*", 3], ["software", 2],
    ["frontend", 3], ["backend", 3], ["full stack", 3], ["fullstack", 3], ["devops", 3],
    ["typescript", 2], ["golang", 2], ["zk", 2], ["protocol", 1], ["coding", 2],
    ["розробник*", 3], ["розробк*", 2], ["розробля*", 2], ["програміст*", 3], ["программист*", 3],
    ["разработчик*", 3], ["разработк*", 2], ["інженер*", 2], ["инженер*", 2], ["смарт-контракт*", 3],
    ["бекенд*", 3], ["фронтенд*", 3], ["бэкенд*", 3], ["фронтэнд*", 3],
  ],
  security_auditor: [
    ["audit*", 4], ["security", 3], ["bug bount*", 3], ["whitehat*", 3], ["white hat*", 3],
    ["pentest*", 3], ["vulnerab*", 3], ["exploit*", 2],
    ["аудит*", 4], ["безпек*", 3], ["безопасн*", 3], ["пентест*", 3], ["вразлив*", 3], ["уязвим*", 3],
  ],
  devrel: [
    ["devrel", 4], ["dev rel", 4], ["developer relation*", 4], ["developer advoca*", 4], ["dev advoca*", 4],
    ["developer evangel*", 4], ["technical writ*", 3], ["developer experience", 3], ["dx", 2],
    ["деврел*", 4], ["технічн* письменн*", 3], ["технический писатель", 3],
  ],
  data_research: [
    ["analyst*", 3], ["analytic*", 3], ["analysis", 2], ["dune", 3], ["research*", 2], ["data", 2], ["sql", 3],
    ["dashboard*", 2], ["on-chain data", 3], ["onchain data", 3],
    ["аналіт*", 3], ["аналит*", 3], ["досліджен*", 2], ["дослідник*", 2], ["исследован*", 2],
    ["исследовател*", 2], ["дані", 2], ["даних", 2], ["данные", 2], ["данных", 2],
  ],
  product_manager: [
    ["product", 2], ["product manag*", 4], ["product owner*", 4], ["project manag*", 4], ["program manag*", 3],
    ["pm", 3], ["scrum*", 3], ["delivery manag*", 3], ["roadmap*", 2],
    ["продакт*", 4], ["проджект*", 4], ["менеджер проєкт*", 4], ["менеджер проект*", 4],
    ["керівник проєкт*", 4], ["керівник проект*", 4], ["руководитель проект*", 4], ["пм", 3],
  ],
  bd: [
    ["bd", 4], ["business development", 4], ["biz dev", 4], ["bizdev", 4], ["partnership*", 4], ["partner*", 2],
    ["sales", 4], ["account executive*", 3], ["account manag*", 3], ["deal flow", 2],
    ["бізнес-розвит*", 4], ["бизнес-развит*", 4],
    ["партнерств*", 4], ["партнер*", 2], ["продаж*", 4], ["сейлз*", 4], ["сейлс*", 4], ["бд", 4],
  ],
  marketing_content: [
    ["marketing*", 4], ["marketer*", 4], ["growth", 3], ["content", 2], ["copywrit*", 3], ["writer*", 2],
    ["writing", 2], ["seo", 3], ["social media", 3], ["smm", 3], ["brand*", 2], ["pr", 2], ["comms", 2],
    ["communications", 2],
    ["маркетинг*", 4], ["маркетолог*", 4], ["контент*", 2], ["копірайт*", 3], ["копирайт*", 3], ["смм", 3],
    ["бренд*", 2], ["піар*", 2], ["пиар*", 2],
  ],
  creator_kol: [
    ["kol", 4], ["kols", 4], ["creator*", 3], ["influencer*", 4], ["youtube*", 3], ["ambassador*", 4],
    ["streamer*", 3], ["podcast*", 3], ["tiktok", 3], ["video*", 2], ["blogger*", 3],
    ["блогер*", 3], ["блоггер*", 3], ["інфлюенсер*", 4], ["инфлюенсер*", 4], ["амбасадор*", 4],
    ["амбассадор*", 4], ["ютуб*", 3], ["креатор*", 3], ["подкаст*", 3], ["відео", 2], ["видео", 2],
  ],
  community: [
    ["community", 4], ["moderator*", 4], ["moderation", 3], ["mod", 2], ["mods", 2], ["discord", 2],
    ["telegram", 1],
    ["комьюніті", 4], ["ком'юніті", 4], ["комюніті", 4], ["комьюнити", 4], ["коммьюнити", 4],
    ["спільнот*", 4], ["сообществ*", 4], ["модератор*", 4], ["модерац*", 3],
  ],
  trader: [
    ["trader*", 4], ["trading", 4], ["trade", 2], ["market maker*", 4], ["market making", 4], ["quant*", 3],
    ["arbitrage", 3], ["degen*", 2], ["perps", 2],
    ["трейдер*", 4], ["трейдинг*", 4], ["торгівл*", 3], ["торговл*", 3], ["маркет-мейк*", 4],
    ["маркетмейк*", 4], ["арбітраж*", 3], ["арбитраж*", 3], ["квант*", 3],
  ],
  designer: [
    ["design*", 4], ["ui", 3], ["ux", 3], ["ui/ux", 4], ["figma", 4], ["illustrat*", 3], ["graphic*", 3],
    ["motion design*", 4],
    ["дизайн*", 4], ["ілюстр*", 3], ["иллюстр*", 3],
  ],
  operations_support: [
    ["operations", 3], ["ops", 2], ["support", 2], ["customer success", 4], ["office manag*", 3],
    ["chief of staff", 4], ["executive assistant*", 4], ["assistant*", 2], ["coordinator*", 2],
    ["операційн*", 3], ["операцион*", 3], ["підтримк*", 2], ["поддержк*", 2], ["саппорт*", 3],
    ["асистент*", 2], ["ассистент*", 2], ["координатор*", 2],
  ],
  finance: [
    ["finance", 4], ["financial", 3], ["accountant*", 4], ["accounting", 4], ["cfo", 4], ["treasury", 4],
    ["controller", 2], ["fp&a", 4], ["bookkeep*", 4],
    ["бухгалт*", 4], ["фінанс*", 4], ["финанс*", 4], ["казначей*", 4],
  ],
  legal_compliance: [
    ["legal", 4], ["lawyer*", 4], ["counsel", 4], ["compliance", 4], ["kyc", 3], ["aml", 3],
    ["regulatory", 3], ["attorney*", 4], ["paralegal*", 4],
    ["юрист*", 4], ["юридичн*", 4], ["юридическ*", 4], ["комплаєнс*", 4], ["комплаенс*", 4], ["адвокат*", 4],
  ],
  hr_recruiting: [
    ["hr", 4], ["recruit*", 4], ["talent*", 3], ["people ops", 4], ["people operations", 4], ["sourcer*", 3],
    ["human resources", 4],
    ["рекрут*", 4], ["ейчар*", 4], ["эйчар*", 4], ["кадров*", 3], ["найм*", 3], ["підбор* персонал*", 4],
  ],
};
// ---- кінець перенесеного ----

/**
 * Доповнення для назв вакансій. Від'ємна вага прибирає хибне прочитання:
 * «Internal Audit» це фінанси, а не аудит смарт-контрактів; «Product Designer»
 * це дизайнер, а не продакт.
 */
const TITLE_TERMS: Partial<Record<RoleKey, Term[]>> = {
  engineer: [
    ["sre", 3], ["site reliability", 3], ["qa", 3], ["sdet", 3], ["architect*", 2], ["blockchain", 1],
    ["forward deployed", 2], ["tech lead", 3], ["cto", 3], ["mobile", 1], ["ios", 2], ["android", 2],
    ["machine learning", 2], ["ml", 1], ["infrastructure", 1], ["quantitative developer*", 3],
    ["developer relation*", -4], ["developer advoca*", -4], ["database administrator*", 4], ["dba", 4], ["cryptograph*", 4], ["technical staff", 4], ["network administrator*", 3],
    ["noc", 3], ["technology lead", 3], ["product development", 2],
  ],
  security_auditor: [
    ["security researcher*", 4], ["security engineer*", 3], ["appsec", 3], ["application security", 3],
    ["red team*", 3], ["offensive security", 3], ["secops", 4], ["threat*", 3], ["cyber*", 3], ["infosec", 3],
    ["information security", 2], ["soc analyst*", 3], ["ciso", 4], ["incident manag*", 3],
    ["internal audit*", -8], ["audit and financ*", -8], ["financial audit*", -8], ["it audit*", -8],
    ["audit manag*", -4], ["security guard*", -8],
  ],
  devrel: [["developer advocate", 2], ["evangelist*", 3], ["documentation", 2], ["solutions engineer*", 1]],
  data_research: [
    ["data scientist*", 4], ["scientist*", 2], ["researcher*", 2], ["data analyst*", 3], ["business intelligence", 3],
    ["bi", 2], ["data science", 4], ["osint", 4], ["open source intelligence", 4], ["market data", 3], ["financial analyst*", -4], ["fraud analyst*", -4], ["aml analyst*", -4], ["kyc analyst*", -4],
  ],
  product_manager: [
    ["product lead", 4], ["head of product", 4], ["director of product", 4], ["vp of product", 4], ["vp product", 4],
    ["program manager*", 1], ["technical program*", 2], ["tpm", 3],
    ["product design*", -2], ["product marketing", -2], ["product support", -2], ["product security", -2],
    ["product engineer*", -2], ["product sales", -2], ["product compliance", -2],
  ],
  bd: [
    ["sdr", 4], ["bdr", 4], ["sales development", 3], ["institutional sales", 2], ["key account*", 3],
    ["sales engineer*", 2], ["listing*", 2], ["relationship manag*", 3], ["otc sales", 2], ["go-to-market", 2],
    ["gtm", 2], ["expansion manag*", 3], ["country manag*", 3], ["alliances", 4], ["solutions consultant*", 3], ["institution*", 2], ["corporate development", 3], ["deal desk", 3],
    ["renewals", 3], ["rfp", 3], ["lead generation", 4], ["investor relations", 3], ["general manager*", 3], ["regional lead*", 2],
    ["market leader*", 2], ["channel account*", 3], ["partner solutions", 3], ["partner success", 2],
  ],
  marketing_content: [
    ["content", 1], ["demand generation", 3], ["lifecycle", 2], ["performance market*", 2], ["affiliate*", 3],
    ["events", 3], ["event manag*", 3], ["paid search", 4], ["paid social", 4], ["media planner*", 4], ["pr lead", 2], ["retention", 2], ["editor*", 3], ["journalist*", 4], ["reporter*", 4], ["crm manag*", 3],
    ["public relations", 4],
  ],
  creator_kol: [["content creator*", 2], ["video producer*", 3], ["video host*", 3], ["livestream*", 3], ["clipping", 3]],
  community: [["community manag*", 2], ["community lead*", 2], ["ecosystem", 1]],
  trader: [
    ["portfolio manag*", 3], ["execution trader*", 2], ["trading analyst*", 5], ["quantitative research*", 5],
    ["quantitative trad*", 5], ["quant research*", 5], ["quant trad*", 5], ["liquidity", 2], ["dealing", 3], ["dealer*", 3], ["trade desk", 3], ["trading platform", -4], ["trading system*", -4],
  ],
  designer: [["creative director", 3], ["visual design*", 2], ["design engineer*", -2], ["user research*", 3], ["artist*", 3]],
  operations_support: [
    ["customer experience", 4], ["customer support", 3], ["client services", 3], ["onboarding specialist*", 3],
    ["business operations", 2], ["office manag*", 1], ["workplace", 3], ["support engineer*", 1], ["onboarding", 3],
    ["client associate*", 3], ["client service*", 3], ["livechat", 3], ["client engagement", 3], ["customer service", 4], ["receptionist*", 4], ["administrator*", 2],
    ["it support", 3], ["it manag*", 3], ["it department", 3], ["it operations", 3], ["front desk", 4], ["front office", 3],
    ["office admin*", 3], ["facilities", 3], ["corporate secretar*", 3], ["servicing", 3], ["complaints", 2],
  ],
  finance: [
    ["internal audit*", 6], ["audit", 2], ["tax", 4], ["payroll", 3], ["accounts payable", 4], ["accounts receivable", 4],
    ["fund accounting", 4], ["reconciliation", 3], ["controller", 2], ["actuar*", 4], ["credit risk", 3],
    ["risk manag*", 3], ["risk", 2], ["risk analyst*", 2], ["head of risk", 2], ["capital markets", 2], ["finops", 4], ["settlement*", 3],
    ["corporate actions", 3], ["credit", 2], ["credit manag*", 2], ["cyber risk", -4], ["underwriting", 3],
    ["investment banking", 3], ["private wealth", 3], ["wealth", 2], ["m and a", 3], ["yield", 2],
  ],
  legal_compliance: [
    ["fraud", 3], ["financial crime*", 4], ["fincrime", 4], ["sanctions", 3], ["privacy", 2], ["mlro", 4],
    ["amlco", 4], ["kyb", 3], ["grc", 3], ["surveillance", 4], ["policy", 2], ["governance", 2], ["consumer protection", 4], ["anti-money launder*", 4],
    ["investigat*", 3], ["transaction monitoring", 4], ["market abuse", 4], ["law enforcement", 3], ["government relations", 3],
    ["litigation", 4], ["complaints", 2], ["internal control*", 3], ["controls", 2], ["trust officer*", 3], ["cass", 3],
  ],
  hr_recruiting: [
    ["talent acquisition", 4], ["people partner*", 4], ["compensation", 3], ["total rewards", 4], ["hris", 4],
    ["people experience", 3], ["hrbp", 4], ["executive search", 4], ["learning and development", 3],
  ],
};

/**
 * Головне слово назви: що людина робитиме. Дає +5 один раз на роль, щоб доменне
 * слово не перебило функцію: «Senior Software Engineer, Trading Platform» це
 * інженер, а не трейдер; «Trading Analyst» це трейдер (див. TITLE_TERMS).
 */
const HEADS: Partial<Record<RoleKey, string[]>> = {
  engineer: ["engineer*", "developer*", "programmer*", "devops", "sre", "site reliability", "architect*", "qa", "sdet", "cto"],
  security_auditor: ["auditor*", "security researcher*", "pentester*", "penetration test*", "whitehat*"],
  devrel: ["devrel", "developer relation*", "developer advoca*", "evangelist*", "technical writer*"],
  data_research: ["data analyst*", "research analyst*", "quantitative analyst*", "investment analyst*", "scientist*", "researcher*"],
  product_manager: ["product manag*", "product owner*", "product lead", "head of product", "project manag*", "program manag*", "scrum master*"],
  bd: ["business development", "bizdev", "account executive*", "sdr", "bdr", "sales representative*", "partnerships", "partnership manag*", "partnerships lead"],
  marketing_content: ["marketer*", "marketing manag*", "copywriter*", "writer*", "editor*", "journalist*", "reporter*", "content strateg*"],
  creator_kol: ["creator*", "influencer*", "ambassador*", "streamer*", "video host*"],
  community: ["moderator*", "community manag*", "community lead*"],
  trader: ["trader*", "market maker*"],
  designer: ["designer*", "artist*"],
  operations_support: ["assistant*", "coordinator*", "chief of staff", "office manag*"],
  finance: ["accountant*", "bookkeeper*", "controller", "cfo", "treasurer*"],
  legal_compliance: ["counsel", "lawyer*", "attorney*", "paralegal*", "compliance officer*", "compliance manag*"],
  hr_recruiting: ["recruiter*", "sourcer*", "talent partner*", "hr manag*", "hr business partner*"],
};

const HEAD_BONUS = 5;
/** Нижче цієї суми роль не рахується: одне слабке слово не робить вакансію роллю. */
const MIN_SCORE = 3;
/** Друга роль вакансії лише якщо вона не набагато слабша за головну. */
const SECOND_ROLE_RATIO = 0.6;
const MAX_JOB_ROLES = 3;

/** Теги NextRole (jobs_cache.tags), що підштовхують роль, яка вже є в назві (+1). */
const TAG_ROLES: Record<string, RoleKey[]> = {
  engineering: ["engineer"],
  security: ["security_auditor"],
  "data-ai": ["data_research"],
  product: ["product_manager"],
  sales: ["bd"],
  partnerships: ["bd"],
  marketing: ["marketing_content"],
  community: ["community"],
  design: ["designer"],
  operations: ["operations_support"],
  support: ["operations_support"],
  "finance-legal": ["finance", "legal_compliance"],
};

/**
 * Назви, що не про нашу аудиторію, хоч джерело й поставило тег web3 (виміряно на
 * живому кеші NextRole 12.09: розшифровувачі аудіо, кухарі, будівельні інженери
 * центрів обробки даних, збір резюме «на майбутнє»).
 */
const NON_CRYPTO_TITLE = new RegExp([
  "transcri\\w*", "data contributor", "language specialist", "ai (?:model )?train(?:er|ing expert)", "annotator",
  "voice (?:actor|talent)", "cuisinier", "cook", "chef", "kitchen", "barista", "waiter", "waitress", "housekeep\\w*",
  "janitor", "cleaner", "security guard", "(?:delivery|truck|bus|taxi|van) driver", "chauffeur", "courier", "warehouse", "forklift", "picker", "packer",
  "plumb\\w*", "electrician", "hvac", "welder", "carpenter", "mason", "construction", "civil engineer\\w*",
  "mechanical engineer\\w*", "electrical (?:design |field )?engineer\\w*", "structural engineer\\w*", "fire protection",
  "high voltage", "technician", "data ?cent(?:er|re)s?", "nurse", "physician", "dental", "pharmac\\w*", "therapist",
  "clinical", "caregiver", "teacher", "sneaker", "apparel", "retail (?:store|associate)", "cashier", "store associate", "merchandis\\w*",
  "procurement", "strategic sourcing", "supply chain", "logistics", "radar", "undersea", "insurance", "actuar\\w*",
  "annuit\\w*", "mortgage", "branch (?:teller|manager)", "teller", "general application", "open application",
  "spontaneous application", "expression of interest", "talent (?:pool|community)", "future opportunit\\w*",
  "resume (?:&|and) information", "propose your dream job",
].map((p) => `(?:${p})`).join("|"), "u");

// Межа слова для будь-якої абетки: \b у JS бачить лише латиницю.
const WORD = "[\\p{L}\\p{N}]";
const NON_CRYPTO = new RegExp(`(?<!${WORD})(?:${NON_CRYPTO_TITLE.source})(?!${WORD})`, "u");

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** «основа*» → основа з будь-яким закінченням; пробіл або дефіс у терміні збігається з обома. */
function termPattern(term: string): RegExp {
  const prefix = term.endsWith("*");
  const body = (prefix ? term.slice(0, -1) : term)
    .split(/(\*| |-)/)
    .map((part) => (part === "*" ? `${WORD}*` : part === " " || part === "-" ? "[\\s-]+" : escape(part)))
    .join("");
  return new RegExp(`(?<!${WORD})${body}${prefix ? "" : `(?!${WORD})`}`, "u");
}

type Compiled = { re: RegExp; weight: number };
const COMPILED: Array<{ role: RoleKey; terms: Compiled[]; heads: RegExp[] }> = ROLE_ORDER.map((role) => ({
  role,
  terms: [...TERMS[role], ...(TITLE_TERMS[role] ?? [])].map(([t, weight]) => ({ re: termPattern(t), weight })),
  heads: (HEADS[role] ?? []).map(termPattern),
}));

/** Нижній регістр, один апостроф, «&» як «and» (крім fp&a), HTML-сутності з джерел. */
export function normalizeTitle(text: string): string {
  return text.normalize("NFC").toLowerCase()
    .replace(/&amp;/g, "&").replace(/[’ʼ`´]/g, "'")
    .replace(/\s*&\s*(?!a\b)/g, " and ")
    .replace(/\s+/g, " ").trim();
}

/** Чи назва явно не про крипто-роль (кухар, розшифровувач аудіо, будівельник). */
export function isNonCryptoTitle(title: string): boolean {
  return NON_CRYPTO.test(normalizeTitle(title));
}

/** Вага кожної ролі для назви; для перевірок і налагодження. */
export function scoreTitle(title: string, tags: readonly string[] = []): Map<RoleKey, number> {
  const text = normalizeTitle(title);
  const out = new Map<RoleKey, number>();
  if (!text) return out;
  const tagged = new Set(tags.flatMap((t) => TAG_ROLES[t.toLowerCase()] ?? []));
  for (const { role, terms, heads } of COMPILED) {
    let score = 0;
    for (const { re, weight } of terms) if (re.test(text)) score += weight;
    if (heads.some((h) => h.test(text))) score += HEAD_BONUS;
    if (score > 0 && tagged.has(role)) score += 1;
    if (score > 0) out.set(role, score);
  }
  return out;
}

/**
 * Ролі вакансії, найсильніша спершу (до трьох). [] для не-крипто назв і назв,
 * у яких немає жодної нашої ролі: такої вакансії в добірці не буде.
 */
export function titleRoles(title: string, tags: readonly string[] = []): RoleKey[] {
  if (!title.trim() || isNonCryptoTitle(title)) return [];
  const scored = [...scoreTitle(title, tags)].filter(([, s]) => s >= MIN_SCORE);
  if (scored.length === 0) return [];
  const top = Math.max(...scored.map(([, s]) => s));
  return scored
    .filter(([, s]) => s >= top * SECOND_ROLE_RATIO)
    .sort((a, b) => b[1] - a[1] || ROLE_ORDER.indexOf(a[0]) - ROLE_ORDER.indexOf(b[0]))
    .slice(0, MAX_JOB_ROLES)
    .map(([r]) => r);
}
