// Сторінка «Scoring your work…» одразу після кроків балу (/welcome/score): чи чекати, чи ставити
// бал у чергу, чи показувати результат, і яку роль показати на картці. Чисті функції, без бази.
import type { RoleKey } from "@/lib/card/roles";
import { displayScore, levelFor } from "@/lib/card/tiers";
import { MAX_WALLETS } from "@/lib/identity/wallets";
import type { IdentityKind } from "@/lib/identity/normalize";
import { isScoredRoleKey } from "@/lib/roles/recipes";
import type { ScoreRow } from "./explain";
import { isActive, type ProfileStatus } from "./status";

/**
 * Що робити зараз:
 * - enqueue: завдання ще не було, або джерела змінились після останнього (крок X, гаманці, джерела
 *   могли прийти, поки черга тримала правило 60 с): поставити бал у чергу;
 * - wait: завдання чекає чи рахується;
 * - failed: останнє завдання впало, а нового нема з чим ставити;
 * - done: бал свіжий, показати результат.
 */
export type PollStep = "enqueue" | "wait" | "failed" | "done";

export function nextPollStep(status: ProfileStatus): PollStep {
  if (isActive(status)) return "wait";
  if (!status.job || status.sourcesChanged) return "enqueue";
  if (status.job.status === "failed") return "failed";
  return "done";
}

/**
 * Скільки кабінет чекає свіжого балу, перш ніж видати першу картку з того балу, що вже є
 * (17.09, власник: «картка сама не створилась»). Причина була така: джерела людина додає по
 * одному вже після анкети, кожна зміна пишеться в audit_log, тож sourcesChanged лишається true,
 * а правило 60 секунд відкидає нове завдання. nextPollStep тоді назавжди «enqueue», і стара
 * умова («видаємо картку лише на кроці done») не видавала її НІКОЛИ, хоч бал уже був.
 *
 * Тут, а не в ready-actions.ts: там "use server", і файл дії може експортувати лише функції
 * (next build падає на константі, тести цього не бачать).
 */
export const CARD_WAIT_MS = 90_000;

/** Скільки чекати перед наступним опитуванням, мс: частіше в перші секунди, далі рідше. */
export function pollDelayMs(elapsedMs: number): number {
  return elapsedMs < 30_000 ? 2_000 : elapsedMs < 120_000 ? 4_000 : 8_000;
}

export type RoleScore = { role: RoleKey; score: number; level: number };

/**
 * Бали ролей людини, найвищий спершу (лише ролі, що рахуються, і з балом); за рівного балу
 * порядок, у якому людина обрала ролі. Яка роль іде на картку вирішує mainRole нижче, не порядок
 * тут (раунд 5, п.7: одна картка на людину, роль = перша обрана, а не найвищий бал).
 */
export function rankRoles(roles: readonly RoleKey[], scores: ReadonlyMap<string, ScoreRow>): RoleScore[] {
  return roles
    .map((role, i) => ({ role, i, row: scores.get(role) }))
    .filter((r): r is { role: RoleKey; i: number; row: ScoreRow } =>
      isScoredRoleKey(r.role) && r.row !== undefined && typeof r.row.score === "number" && Number.isFinite(r.row.score),
    )
    .sort((a, b) => b.row.score! - a.row.score! || a.i - b.i)
    .map(({ role, row }) => ({ role, score: displayScore(row.score!), level: levelFor(row.score!) }));
}

/**
 * Раунд 5, п.7: ОДНА КАРТКА НА ЛЮДИНУ. Роль картки = перша роль, яку людина обрала в брифі
 * (roles[0], порядок анкети), а не найвищий бал. Якщо ця роль ще не порахована (чи ролей взагалі
 * не обрано), беремо найвищий бал серед порахованих; інші бали лишаються лише в розборі (RoleCard).
 */
export function mainRole(roles: readonly RoleKey[], ranked: readonly RoleScore[]): RoleKey | null {
  const first = roles[0];
  if (first && (ranked.length === 0 || ranked.some((r) => r.role === first))) return first;
  return ranked[0]?.role ?? first ?? null;
}

export type Improvement = { key: string; text: string; href: string };

/**
 * «Improve your score»: що ще додати. Гаманці до 10, по одному X (він уже є), GitHub, YouTube, сайт.
 * Порядок: гаманці, GitHub, сайт, YouTube.
 */
export function improvements(identities: readonly { kind: IdentityKind }[]): Improvement[] {
  const has = (k: IdentityKind) => identities.some((i) => i.kind === k);
  const wallets = identities.filter((i) => i.kind === "evm" || i.kind === "solana").length;
  const out: Improvement[] = [];
  if (wallets < MAX_WALLETS) {
    out.push({
      key: "wallets",
      text:
        wallets === 0
          ? `Add your wallets, up to ${MAX_WALLETS}. Onchain history counts for every role and is the Trader score.`
          : `Add more wallets: you have ${wallets} of ${MAX_WALLETS}. Each one adds its history.`,
      href: "/welcome?step=wallets",
    });
  }
  if (!has("github")) {
    out.push({ key: "github", text: "Add GitHub: the main source for Engineer, Security auditor and DevRel.", href: "/welcome?step=sources" });
  }
  if (!has("site")) out.push({ key: "site", text: "Add your website or blog: it adds points to every score.", href: "/welcome?step=sources" });
  if (!has("youtube")) out.push({ key: "youtube", text: "Add YouTube: it counts for Creator and Marketing.", href: "/welcome?step=sources" });
  return out;
}
