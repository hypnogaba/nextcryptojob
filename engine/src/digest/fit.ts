// Чому вакансія підходить людині: одна-три конкретні причини англійською, детерміновано, без моделі.
//
// Сам вибір робить match.ts (selectJobs), і цей модуль його не міняє: лише пояснює вже вибране
// словами людини. Причини в порядку ваги, не більше трьох:
// 1. роль людини, і слова з її «що шукаю» (users.target_text), які є в назві вакансії; або, якщо
//    вакансія підійшла не за роллю, а за своєю роллю словами (users.role_text), ця фраза;
// 2. зарплата, що дотягує до мінімуму людини;
// 3. рівень (senior, entry), якщо людина його назвала і назва вакансії каже те саме;
// 4. місце: місто людини або віддалено, як вона просила;
// 5. її бал за цю роль (scores), якщо він помітний.
// Окремо від причин, завжди: вакансія давніша за FRESH_DAYS каже, що вона досі відкрита й коли
// опублікована (match.ts stillOpenNote), як і whyLine.
// Рядок з причин іде в sent.why, у лист, у Telegram і на сторінку /jobs. Сайт має дослівну копію
// коду нижче першого export (web/src/lib/jobs/fit.ts, тест parity.test.ts): правити тут, потім там.
import type { RoleKey } from "../types.js";
import { type DigestPick, type DigestProfile, foldText, formatSalary, stillOpenNote, workModes } from "./match.js";
import { ROLE_NAMES } from "./roles.js";

export const MAX_REASONS = 3;
/** Бал, від якого він сам є причиною («Your Engineer score is 72»). */
export const SCORE_REASON_MIN = 50;
/** Скільки слів (чи фраз із сусідніх слів) людини назвати в першій причині. */
export const MAX_WORDS = 3;

/** Що ще відомо про людину, крім анкети підбору. */
export interface FitContext {
  /** users.target_text: що людина шукає своїми словами; null, якщо не писала. */
  words: string | null;
  /** Бали людини за ролями (scores.score); немає ролі або null = балу немає. */
  scores: Partial<Record<RoleKey, number | null>>;
}

export type FitPick = Pick<DigestPick, "job" | "role" | "place" | "meetsSalary" | "keyword">;

/** Слова, які нічого не кажуть про вакансію: службові, загальні для крипто, місце, рівень. */
const STOP = new Set([
  "a", "an", "and", "or", "the", "for", "with", "without", "in", "on", "at", "of", "to", "as", "by", "from", "into", "about",
  "i", "im", "me", "my", "we", "you", "your", "our", "am", "is", "are", "be", "been", "being", "will", "would", "can", "could",
  "want", "wants", "looking", "look", "seeking", "seek", "find", "get", "need", "like", "love", "prefer", "ideally", "preferably",
  "maybe", "also", "some", "any", "something", "anything", "that", "this", "these", "those", "where", "which", "who", "what",
  "job", "jobs", "role", "roles", "position", "positions", "work", "working", "career", "opportunity", "opportunities",
  "team", "teams", "company", "companies", "project", "projects", "startup", "startups", "industry", "space", "field",
  "crypto", "web3", "blockchain", "onchain", "chain", "chains",
  "remote", "remotely", "hybrid", "onsite", "office", "anywhere", "worldwide", "city", "based", "relocate", "relocation",
  "full", "time", "fulltime", "part", "parttime", "contractor", "freelance",
  "senior", "sr", "junior", "jr", "lead", "staff", "principal", "head", "entry", "level", "mid", "middle", "intern",
  "internship", "graduate", "trainee", "associate", "experienced", "experience", "years", "year", "yrs",
  "salary", "pay", "paid", "usd", "eur", "gbp", "k", "per", "month", "annual",
  "good", "great", "best", "strong", "new", "own", "etc", "focus", "focused", "especially", "mostly", "mainly", "currently",
  "other", "more", "most", "very", "really", "just", "only", "not", "no", "yes", "ok",
]);

/** Короткі слова, які все ж щось кажуть (zk-роботи, UI/UX тощо); решта коротших за 3 літери відкидається. */
const SHORT_OK = new Set(["zk", "ai", "ml", "ui", "ux", "qa", "bd", "pm", "hr", "l1", "l2"]);

const SUFFIXES = ["ments", "ment", "ings", "ing", "ers", "er", "ors", "or", "ists", "ist", "s"];

/** Слово і його основа без одного закінчення: «engineering» → engineer, «audits» → audit. */
function forms(word: string): string[] {
  const out = [word];
  for (const s of SUFFIXES) {
    if (word.length - s.length >= 4 && word.endsWith(s)) { out.push(word.slice(0, -s.length)); break; }
  }
  return out;
}

const sameWord = (a: string, b: string): boolean => {
  const fb = forms(b);
  return forms(a).some((x) => fb.includes(x));
};

const tokens = (text: string): string[] => foldText(text).split(" ").filter(Boolean);

/**
 * Слова людини, що є в назві вакансії, у порядку назви, без повторів. Сусідні в назві слова йдуть однією
 * фразою («smart contract»). Не рахуються службові слова, слова рівня й місця (про них окремі причини)
 * і слова самої назви ролі («engineer» для Engineer).
 */
export function wordsInTitle(words: string | null, title: string, role: RoleKey): string[] {
  if (!words) return [];
  const roleWords = tokens(ROLE_NAMES[role]);
  const mine = [...new Set(tokens(words))].filter((w) =>
    (w.length >= 3 || SHORT_OK.has(w)) && !STOP.has(w) && !/^\d+k?$/.test(w) && !roleWords.some((r) => sameWord(w, r)));
  const out: string[] = [];
  const used = new Set<string>();
  let last = -2;
  tokens(title).forEach((t, i) => {
    const hit = mine.find((w) => sameWord(w, t));
    if (!hit || used.has(hit)) return;
    used.add(hit);
    if (i === last + 1 && out.length) out[out.length - 1] = `${out[out.length - 1]} ${hit}`;
    else if (out.length < MAX_WORDS) out.push(hit);
    else return;
    last = i;
  });
  return out;
}

const SENIOR = new Set(["senior", "sr", "lead", "staff", "principal", "head", "director", "vp"]);
const JUNIOR = new Set(["junior", "jr", "entry", "intern", "internship", "graduate", "trainee"]);

/** Рівень, названий у тексті: 'senior', 'entry' або null (нічого, або обидва одразу). */
export function levelOf(text: string | null): "senior" | "entry" | null {
  if (!text) return null;
  const t = tokens(text);
  const senior = t.some((w) => SENIOR.has(w));
  const entry = t.some((w) => JUNIOR.has(w));
  return senior === entry ? null : senior ? "senior" : "entry";
}

const SYMBOL: Record<string, string> = { USD: "$", EUR: "€", GBP: "£" };

/** «$120k», «€90k», «CHF 150k». */
function amount(n: number, currency: string | null): string {
  const k = n >= 1000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
  const cur = (currency ?? "USD").toUpperCase();
  const sym = SYMBOL[cur];
  return sym ? `${sym}${k}` : `${cur} ${k}`;
}

/** Місто, як його ввела людина, без країни після коми. */
const cityOf = (city: string): string => (city.split(",")[0] ?? city).trim();

const quoted = (words: readonly string[]): string =>
  words.length === 1 ? `"${words[0]}"` : `${words.slice(0, -1).map((w) => `"${w}"`).join(", ")} and "${words.at(-1)}"`;

/** До MAX_REASONS причин, кожна окремим реченням з крапкою. Перша завжди про роль. */
export function fitReasons(pick: FitPick, profile: DigestProfile, ctx: FitContext): string[] {
  // Роль може бути null: вакансія знайшлась лише словами людини, і в її назві нашої ролі немає.
  const role = pick.role === null ? null : ROLE_NAMES[pick.role];
  const words = pick.keyword || pick.role === null ? [] : wordsInTitle(ctx.words, pick.job.title, pick.role);
  // Підійшла за своєю роллю словами (не за роллю зі списку): кажемо саме це.
  const first = pick.keyword
    ? `Matches "${pick.keyword}" from your own words.`
    : role === null
    ? "Matches your own words."
    : words.length
      ? `Matches your ${role} role, and the title has your words ${quoted(words)}.`
      : `Matches your ${role} role.`;

  const extra: string[] = [];
  const salary = formatSalary(pick.job.salary);
  if (pick.meetsSalary === true && salary && profile.salaryMin) {
    extra.push(`Pays ${salary}, meets your ${amount(profile.salaryMin, profile.salaryCurrency)} minimum.`);
  }
  const level = levelOf(ctx.words);
  if (level && levelOf(pick.job.title) === level) {
    extra.push(level === "senior" ? "A senior role, the level you asked for." : "An entry-level role, the level you asked for.");
  }
  if (pick.place === "city" && profile.city) {
    extra.push(`In ${cityOf(profile.city)}, where you want to work.`);
  } else if (pick.place === "remote") {
    extra.push(workModes(profile.remoteMode).includes("remote") ? "Remote, as you asked." : "Remote.");
  }
  // Для збігу за словами роль вакансії не роль людини, тож її бал тут ні до чого.
  const score = pick.keyword || pick.role === null ? undefined : ctx.scores[pick.role];
  if (typeof score === "number" && score >= SCORE_REASON_MIN) {
    extra.push(`Your ${role} score is ${Math.round(score)}, from your public work.`);
  }
  return [first, ...extra].slice(0, MAX_REASONS).map((r) => r.replace(/[\u2014\u2013]/g, "-"));
}

/** Примітка поруч із причинами: «Still open, posted 6 weeks ago.» для давнішої вакансії; інакше null. */
export function fitNote(pick: FitPick, now: Date): string | null {
  return stillOpenNote(pick.job, now);
}

/** Причини й примітка одним рядком: для sent.why, листа й Telegram. */
export function fitLine(pick: FitPick, profile: DigestProfile, ctx: FitContext, now?: Date): string {
  const note = now ? fitNote(pick, now) : null;
  return [...fitReasons(pick, profile, ctx), ...(note ? [note] : [])].join(" ");
}
