// Ролі зі слів людини (крок 1 анкети, «What job are you looking for?») без вибору зі списку.
// Та сама лінійка, що для назв вакансій (lib/jobs/roles.ts, копія engine/src/digest/roles.ts):
// словник ролей, доповнення для назв і головні слова. Людина, що написала «BD lead», отримує
// роль, за якою добірка шукає вакансії «BD Lead». Зверху кілька слів, які люди пишуть про себе,
// але яких не буває в назвах вакансій. Детерміновано, без моделі: людина потім бачить здогад
// і виправляє його (крок ролей).
import type { RoleKey } from "@/lib/card/roles";
import { normalizeTitle, ROLE_ORDER, scoreTitle } from "@/lib/jobs/roles";
import { MAX_ROLES } from "./catalog";

type Term = [term: string, weight: number];

/**
 * Слова з вільного тексту про себе (англійською, українською, російською). Власник 14.09 написав
 * «комуніті менеджер» і не отримав жодної ролі: у словнику був лише «комьюніті». Тут усі звичні
 * написання, посади «X-менеджер» і слова, яких не буває в назвах вакансій. Від'ємна вага прибирає
 * хибне прочитання («business developer» не інженер).
 */
const FREE_TEXT: Partial<Record<RoleKey, Term[]>> = {
  engineer: [
    ["coder*", 3], ["dapp*", 2], ["cairo", 3], ["move developer*", 2], ["web3 dev*", 2],
    ["business developer*", -7], ["бекендер*", 3], ["фронтендер*", 3], ["девелопер*", 3], ["бізнес девелопер*", -3],
    ["бизнес девелопер*", -3],
  ],
  security_auditor: [["smart contract audit*", 2], ["code4rena", 3], ["sherlock", 2], ["cantina", 2], ["аудитор*", 3]],
  devrel: [["developer advocate*", 2], ["дев рел*", 4]],
  data_research: [
    ["tokenomics", 3], ["token economics", 3], ["on-chain analy*", 3], ["onchain analy*", 3], ["токеноміка", 3],
    ["токеномика", 3], ["ресерч*", 3], ["ресерчер*", 3], ["рісерч*", 3], ["рісерчер*", 3],
  ],
  product_manager: [
    ["ship* product*", 2], ["manager*", 1], ["менеджер*", 1], ["продакт менеджер*", 2],
    ["проджект менеджер*", 2], ["project lead*", 3], ["product lead*", 2], ["керівник продукт*", 4], ["руководитель продукт*", 4],
  ],
  bd: [
    ["deal*", 2], ["closed", 1], ["fundrais*", 3], ["ecosystem lead*", 3], ["ecosystem manag*", 3], ["grants", 2],
    ["бізнес девелоп*", 4], ["бизнес девелоп*", 4], ["партнерк*", 3], ["угод*", 2], ["сделк*", 2],
    ["business developer*", 8], ["bd manag*", 2], ["bd lead*", 2], ["sales manag*", 3], ["manager*", 1], ["менеджер*", 1],
    ["аккаунт менеджер*", 4], ["акаунт менеджер*", 4], ["бізнес розвит*", 4], ["бизнес развит*", 4],
    ["лідген*", 3], ["лидген*", 3], ["business development", 1],
  ],
  marketing_content: [
    ["growth hack*", 3], ["kol manag*", 3], ["kol campaign*", 3], ["ghostwrit*", 3], ["narrative*", 2], ["threads", 1],
    ["twitter", 1], ["x account*", 1], ["socials", 2], ["content manag*", 3], ["content creat*", 1], ["pr manag*", 3],
    ["head of growth", 2], ["growth lead*", 2], ["community manag*", 4], ["community lead*", 4], ["events", 2],
    ["контент менеджер*", 3], ["контент мейкер*", 3], ["контентмейкер*", 3], ["смм менеджер*", 2], ["smm manag*", 2],
    ["таргетолог*", 4], ["піарник*", 3], ["пиарщик*", 3], ["піар менеджер*", 3], ["пиар менеджер*", 3],
    ["комунікац*", 2], ["коммуникац*", 2], ["маркетінг*", 4], ["гроус*", 3], ["гровс*", 3],
    // Комʼюніті в крипті часто частина маркетингу (власник 14.09: «це маркетинг»).
    ["комуніті", 3], ["комунити", 3], ["коммуніті", 3], ["коммунити", 3], ["комьюніті", 3], ["комюніті", 3],
    ["ком'юніті", 3], ["комьюнити", 3], ["коммьюнити", 3], ["коммьюніті", 3],
  ],
  creator_kol: [["caller*", 3], ["shill*", 2], ["stream*", 2], ["followers", 1], ["контент мейкер*", 2], ["ютубер*", 3]],
  community: [
    ["discord", 1], ["ama*", 2], ["raid*", 2], ["ambassador program*", 2],
    ["комуніті", 4], ["комунити", 4], ["коммуніті", 4], ["коммунити", 4], ["коммьюніті", 4], ["коммьюнити", 2],
    ["менеджер спільнот*", 2], ["менеджерка спільнот*", 2], ["чат*", 1],
  ],
  trader: [["scalp*", 3], ["yield farm*", 2], ["farming", 1], ["memecoin*", 2], ["prop trad*", 3]],
  designer: [["дизайнер*", 1]],
  operations_support: [
    ["operations manag*", 2], ["manager*", 1], ["менеджер*", 1], ["ops manag*", 3], ["head of ops", 3],
    ["операційний менеджер*", 2], ["операционный менеджер*", 2], ["офіс менеджер*", 4], ["офис менеджер*", 4],
    ["ассистент*", 1], ["асистент*", 1],
  ],
  hr_recruiting: [["рекрутер*", 1], ["ейчар*", 1], ["hr manag*", 2]],
};

// Межа слова для будь-якої абетки: \b у JS бачить лише латиницю (як у lib/jobs/roles.ts).
const WORD = "[\\p{L}\\p{N}]";

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termPattern(term: string): RegExp {
  const prefix = term.endsWith("*");
  const body = (prefix ? term.slice(0, -1) : term)
    .split(/(\*| |-)/)
    .map((part) => (part === "*" ? `${WORD}*` : part === " " || part === "-" ? "[\\s-]+" : escape(part)))
    .join("");
  return new RegExp(`(?<!${WORD})${body}${prefix ? "" : `(?!${WORD})`}`, "u");
}

const EXTRA = (Object.entries(FREE_TEXT) as [RoleKey, Term[]][]).map(([role, terms]) => ({
  role,
  terms: terms.map(([t, weight]) => ({ re: termPattern(t), weight })),
}));

/** Нижче цієї ваги роль не пропонуємо: одне слабке слово («protocol», «data») не робить роль. */
export const MIN_WEIGHT = 3;
/** Друга й третя роль лише якщо вони не набагато слабші за головну. */
const RATIO = 0.3;

/** Вага кожної ролі для тексту людини. Для перевірок і налагодження. */
export function roleWeights(text: string): Map<RoleKey, number> {
  const out = scoreTitle(text ?? "");
  const normalized = normalizeTitle(text ?? "");
  if (!normalized) return out;
  for (const { role, terms } of EXTRA) {
    let add = 0;
    for (const { re, weight } of terms) if (re.test(normalized)) add += weight;
    if (add !== 0) out.set(role, (out.get(role) ?? 0) + add);
  }
  return out;
}

/**
 * До трьох ролей з тексту, найсильніша спершу; [] якщо жодна не впевнена.
 * За рівної ваги порядок договору §1.
 */
export function inferRoles(text: string, limit = MAX_ROLES): RoleKey[] {
  const ranked = [...roleWeights(text)].filter(([, w]) => w >= MIN_WEIGHT);
  if (ranked.length === 0) return [];
  const top = Math.max(...ranked.map(([, w]) => w));
  return ranked
    .filter(([, w]) => w >= top * RATIO)
    .sort((a, b) => b[1] - a[1] || ROLE_ORDER.indexOf(a[0]) - ROLE_ORDER.indexOf(b[0]))
    .slice(0, limit)
    .map(([role]) => role);
}

// ---------------------------------------------------------------------------
// Найближчі ролі, коли певної немає (власник 14.09: «треба щось запропонувати»).

/** Кирилиця латиницею, щоб порівняти «маркетінг» чи «девелопер» зі словами ролей. */
const TRANSLIT: Record<string, string> = {
  а: "a", б: "b", в: "v", г: "g", ґ: "g", д: "d", е: "e", є: "e", ж: "zh", з: "z", и: "i", і: "i", ї: "i", й: "i",
  к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f", х: "h", ц: "ts", ч: "ch",
  ш: "sh", щ: "sch", ь: "", ъ: "", ы: "y", э: "e", ю: "u", я: "ya", "'": "",
};

function latin(text: string): string {
  return [...text].map((ch) => TRANSLIT[ch] ?? ch).join("");
}

/** Слова ролей латиницею для порівняння з помилками й транслітом («markting», «комьюнiти»). */
const VOCAB: Record<RoleKey, string[]> = {
  engineer: ["engineer", "developer", "programmer", "solidity", "rust", "frontend", "backend", "fullstack", "devops", "razrabotchik", "rozrobnik"],
  security_auditor: ["auditor", "audit", "security", "pentester", "whitehat"],
  devrel: ["devrel", "advocate", "evangelist", "documentation"],
  data_research: ["analyst", "analytics", "research", "researcher", "scientist", "tokenomics", "analitik"],
  product_manager: ["product", "project", "scrum", "roadmap", "prodakt", "prodzhekt"],
  bd: ["business", "partnerships", "partner", "sales", "bizdev", "prodazhi", "biznes"],
  marketing_content: ["marketing", "marketer", "growth", "content", "copywriter", "brand", "social", "kontent", "marketolog"],
  creator_kol: ["creator", "influencer", "youtuber", "blogger", "streamer", "ambassador", "bloger"],
  community: ["community", "moderator", "discord", "komuniti", "komyuniti", "spilnota"],
  trader: ["trader", "trading", "quant", "treider"],
  designer: ["designer", "design", "figma", "illustrator", "dizainer"],
  operations_support: ["operations", "support", "assistant", "coordinator", "office"],
  finance: ["finance", "accountant", "accounting", "treasury", "buhgalter"],
  legal_compliance: ["lawyer", "legal", "compliance", "counsel", "yurist"],
  hr_recruiting: ["recruiter", "recruiting", "talent", "rekruter"],
};

/** Схожість двох слів 0..1: 1 мінус відстань Левенштейна до довшого. */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}

/** Нижче цієї схожості слово не схоже на жодну роль. */
const FUZZY_MIN = 0.72;

/** Найбільша схожість слів тексту зі словами кожної ролі (лише ті, що вище FUZZY_MIN). */
function fuzzyWeights(text: string): Map<RoleKey, number> {
  const words = latin(normalizeTitle(text)).split(/[^a-z0-9]+/).filter((w) => w.length >= 4);
  const out = new Map<RoleKey, number>();
  for (const role of ROLE_ORDER) {
    let best = 0;
    for (const w of words) {
      for (const v of VOCAB[role]) {
        // «marketingu», «developers»: порівнюємо і з початком слова такої ж довжини, як слово ролі.
        best = Math.max(best, similarity(w, v), w.length > v.length ? similarity(w.slice(0, v.length), v) : 0);
      }
    }
    if (best >= FUZZY_MIN) out.set(role, best);
  }
  return out;
}

/**
 * Коли в словах немає жодного знайомого сліду: широкі нетехнічні ролі. Інженер, аудитор
 * чи трейдер майже завжди називають свою мову, мережу чи біржу, і тоді вага вже є.
 */
export const DEFAULT_CLOSEST: readonly RoleKey[] = ["marketing_content", "community", "bd"];

export type RoleGuess = { roles: RoleKey[]; confident: boolean };

/**
 * Ролі для кроку ролей: певні (inferRoles), а якщо певних немає, три найближчі, щоб людина
 * побачила здогад, а не порожнечу. Найближчі за сумою: слабкі слова («manager», «protocol») і
 * схожі слова з помилками чи транслітом («markting»); чого бракує до трьох, з DEFAULT_CLOSEST.
 * Порожній текст: нічого.
 */
export function guessRoles(text: string, limit = MAX_ROLES): RoleGuess {
  const sure = inferRoles(text, limit);
  if (sure.length > 0) return { roles: sure, confident: true };
  if (!normalizeTitle(text ?? "")) return { roles: [], confident: false };
  // Слабке слово дає свою вагу, схоже слово до 3 (як одне сильне слово словника).
  const closeness = new Map<RoleKey, number>();
  for (const [role, w] of roleWeights(text)) if (w > 0) closeness.set(role, w);
  for (const [role, sim] of fuzzyWeights(text)) closeness.set(role, (closeness.get(role) ?? 0) + sim * 3);
  const out = [...closeness]
    .sort((a, b) => b[1] - a[1] || ROLE_ORDER.indexOf(a[0]) - ROLE_ORDER.indexOf(b[0]))
    .map(([role]) => role)
    .slice(0, limit);
  for (const role of DEFAULT_CLOSEST) if (out.length < limit && !out.includes(role)) out.push(role);
  return { roles: out, confident: false };
}
