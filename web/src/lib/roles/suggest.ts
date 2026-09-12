// Підказка ролей зі слів людини («What job are you looking for?»).
// Детерміновано, без моделі: словник ключових слів англійською, українською й
// російською. Людина потім сама підтверджує або міняє ролі (урок NextRole:
// лише кнопки-категорії люди натискали не ті).
import type { RoleKey } from "@/lib/card/roles";
import { MAX_ROLES, ROLE_ORDER } from "./catalog";

/**
 * Термін: `слово` збігається лише цілим словом, `основа*` з будь-яким
 * закінченням (для відмінків: «розробником», «смарт-контрактів»).
 * Вага: 3 сильна ознака ролі, 2 звичайна, 1 слабка.
 */
type Term = [term: string, weight: number];

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

// Межа слова для будь-якої абетки: \b у JS бачить лише латиницю.
const WORD = "[\\p{L}\\p{N}]";

function escape(s: string): string {
  // У режимі u зайве екранування (\& чи \/) є помилкою, тож лише спецсимволи.
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

const COMPILED = ROLE_ORDER.map((role) => ({
  role,
  terms: TERMS[role].map(([term, weight]) => ({ re: termPattern(term), weight })),
}));

/** Нижній регістр і один апостроф: «Ком’юніті» і «комʼюніті» однакові. */
function normalizeText(text: string): string {
  return text.normalize("NFC").toLowerCase().replace(/[’ʼ`´]/g, "'");
}

/**
 * До трьох ролей, найсильніші спершу. Вага ролі = сума ваг різних термінів,
 * що трапились у тексті; за рівної ваги перша та, про яку людина сказала раніше,
 * далі порядок договору.
 */
export function suggestRoles(text: string, limit = MAX_ROLES): RoleKey[] {
  const input = normalizeText(text ?? "");
  if (!input.trim()) return [];
  const ranked: { role: RoleKey; score: number; first: number; order: number }[] = [];
  COMPILED.forEach(({ role, terms }, order) => {
    let score = 0;
    let first = Infinity;
    for (const { re, weight } of terms) {
      const m = re.exec(input);
      if (!m) continue;
      score += weight;
      first = Math.min(first, m.index);
    }
    if (score > 0) ranked.push({ role, score, first, order });
  });
  ranked.sort((a, b) => b.score - a.score || a.first - b.first || a.order - b.order);
  return ranked.slice(0, limit).map((r) => r.role);
}
