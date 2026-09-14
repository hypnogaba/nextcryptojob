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

/** Слова з вільного тексту про себе (англійською, українською, російською). */
const FREE_TEXT: Partial<Record<RoleKey, Term[]>> = {
  engineer: [["coder*", 3], ["dapp*", 2], ["cairo", 3], ["move developer*", 2], ["web3 dev*", 2]],
  security_auditor: [["smart contract audit*", 2], ["code4rena", 3], ["sherlock", 2], ["cantina", 2]],
  data_research: [["tokenomics", 3], ["token economics", 3], ["on-chain analy*", 3], ["onchain analy*", 3], ["токеноміка", 3], ["токеномика", 3]],
  product_manager: [["ship* product*", 2]],
  bd: [
    ["deal*", 2], ["closed", 1], ["fundrais*", 3], ["ecosystem lead*", 3], ["ecosystem manag*", 3], ["grants", 2],
    ["бізнес девелоп*", 4], ["бизнес девелоп*", 4], ["партнерк*", 3], ["угод*", 2], ["сделк*", 2],
  ],
  marketing_content: [
    ["growth hack*", 3], ["kol manag*", 3], ["kol campaign*", 3], ["ghostwrit*", 3], ["narrative*", 2], ["threads", 1],
    ["twitter", 1], ["x account*", 1],
  ],
  creator_kol: [["caller*", 3], ["shill*", 2], ["stream*", 2], ["followers", 1]],
  community: [["discord", 1], ["ama*", 2], ["raid*", 2], ["ambassador program*", 2]],
  trader: [["scalp*", 3], ["yield farm*", 2], ["farming", 1], ["memecoin*", 2], ["prop trad*", 3]],
  operations_support: [["operations manag*", 2]],
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
    if (add > 0) out.set(role, (out.get(role) ?? 0) + add);
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
