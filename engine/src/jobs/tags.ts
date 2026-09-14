// Перенесено з NextRole (crypto-jobs-agent, scanner): src/tags.ts, лише правила сфер.
//
// Галузь тут одна й відома наперед: у базу NextCryptoJob іде лише крипто, тож тег `web3` стоїть
// у кожного рядка (його перевіряють запити пулу, engine/src/digest/jobs.ts). Сфера з назви посади
// лишається: добірка нею підштовхує роль, що вже є в назві (engine/src/digest/roles.ts TAG_ROLES).

const SPHERE_RULES: Array<[string, RegExp]> = [
  // «platform», «infrastructure» і «mobile» самі по собі звідси прибрані: вони ловили посаду за
  // словом із назви продукту («Client Account Executive, T-Mobile»), а не за фахом. Справжня
  // платформна інженерія слова «engineer» не втрачає.
  ["engineering",  /\b(engineer(?:s|ing)?|developers?|programmers?|swe|backend|frontend|full[- ]?stack|ios|android|devops|sre|sysadmin|architects?)\b/i],
  ["data-ai",      /\b(data scientists?|data engineers?|machine learning|ml engineers?|ai engineers?|analytics engineers?|research scientists?|mlops|nlp)\b/i],
  ["design",       /\b(designers?|ux|ui|product design|graphic|figma|brand design|motion)\b/i],
  ["product",      /\b(product managers?|product owners?|product leads?|product design(?:ers?)?)\b/i],
  ["devrel",       /\b(developers? relations|devrel|developers? advocates?|community managers?|community leads?|evangelists?)\b/i],
  ["partnerships", /\b(partnerships?|business development|bd managers?|alliances|ecosystems?)\b/i],
  ["operations",   /\b(operations|program managers?|project managers?|chief of staff|people ops|hr managers?|recruiters?)\b/i],
  ["marketing",    /\b(marketing|growth|content|brand|seo|demand generation|communications)\b/i],
  ["sales",        /\b(sales|account executives?|account managers?|customer success|solutions engineers?)\b/i],
  // «compliance» саме по собі прибрано: воно ловило фінансовий комплаєнс і право, а не безпеку.
  ["security",     /\b(security|appsec|infosec|penetration|pentest|grc|soc ?2|iso ?27001)\b/i],
  ["qa",           /\b(qa engineers?|quality assurance|test engineers?|sdet)\b/i],
  ["support",      /\b(support|technical support|helpdesk|customer service)\b/i],
  ["finance-legal",/\b(finance|accountant|controller|legal|counsel|compliance officer|tax)\b/i],
];

/**
 * Сфери з тегів самої дошки (web3.career): лише теги ролі, і лише в ті сфери, які добірка знає
 * (engine/src/digest/roles.ts TAG_ROLES). Сфера лише підштовхує роль, що вже є в назві (+1), тож
 * шумний тег дошки («react» у менеджера спільноти) ролі не створює. Мови й екосистеми не беремо.
 */
const BOARD_SPHERES: Record<string, string> = {
  backend: "engineering", "front-end": "engineering", "full-stack": "engineering", "smart-contract": "engineering",
  devops: "engineering", mobile: "engineering",
  security: "security", "data-science": "data-ai", design: "design", "product-manager": "product",
  "developer-relations": "devrel", "community-manager": "community", moderator: "community",
  marketing: "marketing", sales: "sales", "business-development": "partnerships", "customer-support": "support",
};

export function boardSpheres(tags: readonly string[] | undefined): string[] {
  const out: string[] = [];
  for (const t of tags ?? []) {
    const s = BOARD_SPHERES[t.toLowerCase()];
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** Теги рядка: `web3` першим, далі сфери з назви і з тегів дошки, `remote` для віддалених. */
export function jobTags(title: string, remote: boolean, boardTags?: readonly string[]): string[] {
  const tags = ["web3"];
  for (const [tag, rx] of SPHERE_RULES) if (rx.test(title)) tags.push(tag);
  for (const s of boardSpheres(boardTags)) if (!tags.includes(s)) tags.push(s);
  if (remote) tags.push("remote");
  return tags;
}
