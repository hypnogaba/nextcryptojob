import type { RoleKey } from "@/lib/card/roles";
import { guessRoles, inferRoles } from "@/lib/roles/infer";
import { SCORED_ROLE_KEYS } from "@/lib/roles/recipes";
import { CHAIN_TEXT, roleText } from "./labels";
import type { Job } from "./jobs";
import { CHAINS, type CandidateSummary, type Chain, type SearchFilters } from "./types";

/**
 * Шортлист за брифом (ідея Jill з Jack & Jill, 18.09): компанія вставляє текст вакансії або
 * відкриває свою вакансію, ми читаємо з тексту роль, місце й мережі і показуємо 10 найкращих
 * з одного пошуку. Детерміновано, без моделі, як і ролі кандидата (lib/roles/infer.ts):
 * компанія бачить здогад і може його змінити.
 *
 * Жорсткі фільтри лише роль і місце роботи. Мережі НЕ фільтр: інженер без доданого гаманця
 * на Solana може бути найкращим для Solana-команди, тож мережа дає лише рядок «чому підходить».
 */

export const BRIEF_MAX = 5000;
export const SHORTLIST_SIZE = 10;

export interface Brief {
  /** Ролі за силою; перша йде в пошук, решта кнопками. Порожньо: роль обирає компанія. */
  roles: RoleKey[];
  /** Чи роль прочитано певно (інакше показуємо як здогад). */
  confident: boolean;
  work: "remote" | "city" | null;
  city: string | null;
  chains: Chain[];
  /** Верхня межа зарплати вакансії за рік, якщо відома. */
  salaryMaxYear: { amount: number; currency: string } | null;
}

const SCORED = new Set<RoleKey>(SCORED_ROLE_KEYS);

/**
 * Мережі за словами. «Base» окремо лише з уточненням: «base salary», «codebase», «database»
 * у кожній другій вакансії. EVM і Solidity не значать жодної мережі з переліку.
 */
const CHAIN_PATTERNS: [Chain, RegExp][] = [
  ["ethereum", /\b(ethereum|mainnet eth|eth l1)\b/i],
  ["base", /\b(on base|base (chain|network|l2|ecosystem|app)|coinbase'?s l2)\b/i],
  ["arbitrum", /\barbitrum\b/i],
  ["optimism", /\b(optimism|op stack|op mainnet|superchain)\b/i],
  ["solana", /\b(solana|anchor framework|svm)\b/i],
  ["hyperliquid", /\b(hyperliquid|hyperevm|hypercore)\b/i],
];

const REMOTE = /\b(remote|fully distributed|work from anywhere|anywhere in the world)\b/i;
const ONSITE = /\b(on[- ]?site|in[- ]office|hybrid|relocat\w*)\b/i;

function scored(roles: RoleKey[]): RoleKey[] {
  return roles.filter((r) => SCORED.has(r));
}

/** Ролі тексту: назва (перший рядок) важить найбільше, бо опис згадує багато чужих слів. */
function rolesOf(text: string): { roles: RoleKey[]; confident: boolean } {
  const title = text.split("\n").find((l) => l.trim())?.trim() ?? "";
  const fromTitle = scored(inferRoles(title));
  if (fromTitle.length) return { roles: fromTitle, confident: true };
  const guess = guessRoles(text);
  return { roles: scored(guess.roles), confident: guess.confident };
}

export function chainsOf(text: string): Chain[] {
  return CHAIN_PATTERNS.filter(([, re]) => re.test(text)).map(([c]) => c);
}

/** Вставлений текст → бриф. Місто з тексту не вгадуємо: компанія дописує його сама. */
export function briefFromText(raw: string): Brief {
  const text = (raw ?? "").slice(0, BRIEF_MAX);
  const remote = REMOTE.test(text);
  const onsite = ONSITE.test(text);
  return {
    ...rolesOf(text),
    // «Remote or on-site» лишає місце відкритим: не відсікаємо нікого.
    work: remote && !onsite ? "remote" : null,
    city: null,
    chains: chainsOf(text),
    salaryMaxYear: null,
  };
}

/** Своя вакансія компанії → бриф: ролі, місце й зарплату вже вказано у формі. */
export function briefFromJob(
  job: Pick<Job, "title" | "roles" | "work_mode"> & Partial<Pick<Job, "description" | "city" | "salary">>,
): Brief {
  const modes = job.work_mode;
  const cityOnly = modes.includes("city") && !modes.includes("remote") && job.city;
  const s = job.salary;
  const max = s?.max ?? null;
  return {
    roles: scored([...job.roles]),
    confident: true,
    work: cityOnly ? "city" : modes.length === 1 && modes[0] === "remote" ? "remote" : null,
    city: cityOnly ? job.city! : null,
    chains: chainsOf(`${job.title}\n${job.description ?? ""}`),
    salaryMaxYear: s && max ? { amount: s.period === "month" ? max * 12 : max, currency: s.currency } : null,
  };
}

/** Бриф → фільтри одного пошуку. Хто вже у воронці, не показуємо: шортлист про нових людей. */
export function briefFilters(brief: Brief, role: RoleKey): SearchFilters {
  const f: SearchFilters = { role, exclude_in_pipeline: true };
  if (brief.work === "remote") f.work_mode = "remote";
  if (brief.work === "city" && brief.city) {
    f.work_mode = "city";
    f.city = brief.city;
  }
  return f;
}

/** Бриф у адресі /company/shortlist (без самого тексту: він може бути довгим і приватним). */
export function briefQuery(brief: Brief, role?: RoleKey, jobId?: string): string {
  const q = new URLSearchParams();
  const first = role ?? brief.roles[0];
  if (first) q.set("role", first);
  if (brief.roles.length) q.set("roles", brief.roles.join(","));
  if (!brief.confident) q.set("guess", "1");
  if (brief.work) q.set("work", brief.work);
  if (brief.work === "city" && brief.city) q.set("city", brief.city);
  if (brief.chains.length) q.set("chains", brief.chains.join(","));
  if (brief.salaryMaxYear) q.set("salary", `${brief.salaryMaxYear.amount}${brief.salaryMaxYear.currency}`);
  if (jobId) q.set("job", jobId);
  return q.toString();
}

type Params = Record<string, string | string[] | undefined>;

function one(params: Params, key: string): string {
  const v = params[key];
  return ((Array.isArray(v) ? v[0] : v) ?? "").trim();
}

/** Адреса → бриф і обрана роль. Невідомі значення тихо відкидаємо. */
export function briefFromParams(params: Params): { brief: Brief; role: RoleKey | null } {
  const roles = one(params, "roles")
    .split(",")
    .filter((r): r is RoleKey => SCORED.has(r as RoleKey))
    .slice(0, 3);
  const roleRaw = one(params, "role") as RoleKey;
  const role = SCORED.has(roleRaw) ? roleRaw : (roles[0] ?? null);
  if (role && !roles.includes(role)) roles.unshift(role);
  const work = one(params, "work");
  const city = one(params, "city").slice(0, 80);
  const chains = one(params, "chains")
    .split(",")
    .filter((c): c is Chain => (CHAINS as readonly string[]).includes(c));
  const salary = /^(\d{4,7})([A-Z]{3})$/.exec(one(params, "salary"));
  return {
    role,
    brief: {
      roles,
      confident: one(params, "guess") !== "1",
      work: work === "remote" ? "remote" : work === "city" && city ? "city" : null,
      city: work === "city" && city ? city : null,
      chains: [...new Set(chains)],
      salaryMaxYear: salary ? { amount: Number(salary[1]), currency: salary[2] } : null,
    },
  };
}

const NUMBER = new Intl.NumberFormat("en-US");

/**
 * «Чому підходить»: лише те, що видно в анонімному профілі. Порядок: роль, місце, мережі,
 * зарплата. Незбіг зарплати теж кажемо: компанії краще знати до запиту знайомства.
 */
export function fitReasons(c: CandidateSummary, brief: Brief, role: RoleKey): string[] {
  const out: string[] = [];
  const r = c.roles.find((x) => x.role === role) ?? (c.headline.role === role ? c.headline : null);
  if (r && r.score !== null) out.push(`${roleText(role)} score ${r.score}, level ${r.level}`);
  if (brief.work === "remote" && c.work.modes.includes("remote")) out.push("Wants remote");
  if (brief.work === "city" && brief.city) out.push(`Open to ${brief.city}`);
  const shared = brief.chains.filter((ch) => c.chains.includes(ch));
  if (shared.length) out.push(`Active on ${shared.map((ch) => CHAIN_TEXT[ch]).join(", ")}`);
  const floor = c.salary_floor;
  const max = brief.salaryMaxYear;
  if (floor && max && floor.currency === max.currency) {
    out.push(
      floor.amount <= max.amount
        ? `Salary floor ${NUMBER.format(floor.amount)} ${floor.currency} fits your range`
        : `Asks from ${NUMBER.format(floor.amount)} ${floor.currency}, above your range`,
    );
  }
  if (c.contact_mode === "direct") out.push("Telegram available now");
  return out;
}

/** Опис здогаду для компанії: що саме ми прочитали з тексту. */
export function describeBrief(brief: Brief): string[] {
  const out: string[] = [];
  if (brief.work === "remote") out.push("remote");
  if (brief.work === "city" && brief.city) out.push(`in ${brief.city}`);
  if (brief.chains.length) out.push(`${brief.chains.map((c) => CHAIN_TEXT[c]).join(", ")} (preferred, not required)`);
  if (brief.salaryMaxYear) out.push(`up to ${NUMBER.format(brief.salaryMaxYear.amount)} ${brief.salaryMaxYear.currency} a year`);
  return out;
}
