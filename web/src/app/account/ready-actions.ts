"use server";

import { firstCardName, issueCard } from "@/lib/card/issue";
import { cardPath } from "@/lib/card/share";
import { listActiveCards } from "@/lib/card/store";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/auth/session";
import { getIdentity } from "@/lib/identity/store";
import { loadAnswers } from "@/lib/onboarding/store";
import { enqueueScoreJob } from "@/lib/score/queue";
import { loadScores } from "@/lib/score/load";
import { CARD_WAIT_MS, mainRole, nextPollStep, rankRoles } from "@/lib/score/result";
import { profileStatus } from "@/lib/score/status";

/**
 * Раунд 5, п.2 + п.14 (веб): «Skip, go to my account» відправляє людину геть з /welcome/score
 * до того, як бал готовий. Картка тоді має з'явитись сама, без повернення на ту сторінку: цю дію
 * питає ScoreReadyWatcher (account-nav-area компонент), поки бал не готовий і картки ще нема.
 * Та сама логіка, що issueFirstCardAction (welcome/actions/score.ts), лише без ролі з форми:
 * роль береться найвищим балом, як на /welcome/score.
 */
export type ReadyCheck = { ready: false } | { ready: true; slug: string; path: string };

export async function checkScoreReadyAction(waitedMs = 0): Promise<ReadyCheck> {
  const user = await requireUser();
  const d = db();
  const status = await profileStatus(d, user.id);
  const step = nextPollStep(status);

  // Кабінет сам добиває чергу (16.09): перше завдання на вході рахувало ще без джерел, а
  // наступні спроби відкидало правило 60 секунд, тож без цього бал не з'являвся, доки людина
  // не натисне «Update» руками. Черга сама не дублює; force лише тим, у кого бала ще немає.
  if (step === "enqueue") await enqueueScoreJob(d, user.id, "connect", { force: !status.scored });

  // Без жодного балу картки нема з чого робити: чекаємо рушій.
  if (!status.scored) return { ready: false };
  // Бал є, але рушій зараз рахує свіжий (чи ми щойно його поставили): перша картка варта того,
  // щоб зачекати кілька секунд і стати з новим балом. Не довше за CARD_WAIT_MS.
  if (step !== "done" && step !== "failed" && waitedMs < CARD_WAIT_MS) return { ready: false };

  const [answers, scores, cards] = await Promise.all([loadAnswers(d, user.id), loadScores(d, user.id), listActiveCards(d, user.id)]);
  const ranked = rankRoles(answers.roles, scores);
  // Раунд 5, п.7: одна картка на людину, роль = головна (перша обрана в брифі), не найвищий бал.
  const main = mainRole(answers.roles, ranked);
  const best = ranked.find((r) => r.role === main) ?? null;
  if (!best) return { ready: false };

  const active = cards.find((c) => c.role === best.role);
  if (active) return { ready: true, slug: active.slug, path: cardPath(active.slug) };

  const x = await getIdentity(d, user.id, "x");
  let issued;
  try {
    issued = await issueCard(d, user.id, { role: best.role, displayName: firstCardName(x?.value ?? null, user.email), reuse: true });
  } catch (err) {
    console.error("score-ready auto-issue failed:", err instanceof Error ? err.message : String(err));
    return { ready: false };
  }
  if (!issued.ok) return { ready: false };
  return { ready: true, slug: issued.slug, path: cardPath(issued.slug) };
}
