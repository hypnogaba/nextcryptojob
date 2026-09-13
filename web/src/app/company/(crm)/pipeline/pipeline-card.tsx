import Link from "next/link";
import { FIELD } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { POS, ScoreChip } from "@/components/board";
import { EmptyChip } from "@/components/crm/candidate-row";
import { Chip } from "@/components/crm/ui";
import { expiresInText, roleScoreText, STAGE_TEXT } from "@/lib/crm/labels";
import type { PipelineCard } from "@/lib/crm/pipeline";
import { HIDDEN_NOTICE, type Stage } from "@/lib/crm/types";
import { POSITION_CODE } from "@/lib/roles/recipes";
import { moveCardAction, withdrawIntroAction } from "./actions";

/** Куди картку можна перенести вручну (5.4): Interview і Hired лише з відкритим контактом. */
export function movesFor(card: Pick<PipelineCard, "stage" | "contact">): Stage[] {
  if (card.stage === "intro_requested") return [];
  return (["found", "interview", "hired", "declined"] as Stage[]).filter(
    (s) => s !== card.stage && ((s !== "interview" && s !== "hired") || card.contact !== null),
  );
}

/** Прихований контекст форм воронки: компанія й куди повернутись. */
export function BackFields({ companyId, view, job, tag }: { companyId: string; view?: string; job?: string; tag?: string }) {
  return (
    <>
      <input type="hidden" name="company_id" value={companyId} />
      {view ? <input type="hidden" name="view" value={view} /> : null}
      {job ? <input type="hidden" name="job" value={job} /> : null}
      {tag ? <input type="hidden" name="tag" value={tag} /> : null}
    </>
  );
}

export function MoveForm({ card, back, canWrite }: { card: PipelineCard; back: Parameters<typeof BackFields>[0]; canWrite: boolean }) {
  const moves = movesFor(card);
  if (!canWrite || moves.length === 0) return null;
  const id = `move-${card.candidate_id}-${back.view ?? "board"}`;
  return (
    <form action={moveCardAction} className="grid gap-2">
      <BackFields {...back} />
      <input type="hidden" name="candidate_id" value={card.candidate_id} />
      <label htmlFor={id} className="sr-only">
        Move {card.label} to
      </label>
      <select id={id} name="stage" defaultValue="" required className={`${FIELD} h-11 text-sm`}>
        <option value="" disabled>
          Move to...
        </option>
        {moves.map((s) => (
          <option key={s} value={s}>
            {STAGE_TEXT[s]}
          </option>
        ))}
      </select>
      <SubmitButton pendingLabel="Moving..." variant="outline" className="h-11 px-3 text-sm" aria-label={`Move ${card.label}`}>
        Move
      </SubmitButton>
    </form>
  );
}

export function WithdrawForm({ card, back, canWrite }: { card: PipelineCard; back: Parameters<typeof BackFields>[0]; canWrite: boolean }) {
  if (!canWrite || !card.open_intro) return null;
  return (
    <form action={withdrawIntroAction}>
      <BackFields {...back} />
      <input type="hidden" name="intro_id" value={card.open_intro.intro_id} />
      <SubmitButton pendingLabel="Withdrawing..." variant="outline" className="h-11 px-3 text-sm" aria-label={`Withdraw the intro with ${card.label}`}>
        Withdraw
      </SubmitButton>
    </form>
  );
}

/** Картка на дошці (W4): мітка, бал, теги, стан знайомства чи контакт, "Move to...". */
export function BoardCard({ card, back, canWrite, now }: { card: PipelineCard; back: Parameters<typeof BackFields>[0]; canWrite: boolean; now: Date }) {
  return (
    <article className="grid gap-2.5 rounded-lg border border-line bg-surface p-3" aria-labelledby={`card-${card.candidate_id}`}>
      <div className="flex items-center gap-3">
        {card.visibility !== "hidden" && card.headline?.score != null ? (
          <ScoreChip score={card.headline.score} level={card.headline.level} className="w-10" />
        ) : (
          <EmptyChip className="w-10" />
        )}
        <div className="grid min-w-0 gap-1">
          <Link
            id={`card-${card.candidate_id}`}
            href={`/company/candidates/${card.candidate_id}`}
            prefetch={false}
            className="font-mono text-sm font-semibold break-all text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand"
          >
            {card.label}
          </Link>
          {card.visibility !== "hidden" && card.headline ? <span className={POS}>{POSITION_CODE[card.headline.role]}</span> : null}
        </div>
      </div>
      {card.visibility === "hidden" ? (
        <p className="text-sm text-ink-muted">{HIDDEN_NOTICE}</p>
      ) : card.headline ? (
        <p className="text-sm text-ink">{roleScoreText(card.headline)}</p>
      ) : null}
      {card.stage === "declined" && card.declined_by ? <p className="text-sm text-ink-muted">by {card.declined_by}</p> : null}
      {card.tags.length ? (
        <p className="flex flex-wrap gap-1">
          {card.tags.map((t) => (
            <Chip key={t}>{t}</Chip>
          ))}
        </p>
      ) : null}
      {card.open_intro ? <p className="text-sm text-ink-muted">{expiresInText(card.open_intro.expires_at, now)}</p> : null}
      {card.contact ? <p className="font-mono text-sm break-all text-ink">{card.contact.value}</p> : null}
      {card.note_count ? (
        <p className="text-xs text-ink-muted">
          {card.note_count} {card.note_count === 1 ? "note" : "notes"}
        </p>
      ) : null}
      <MoveForm card={card} back={back} canWrite={canWrite} />
      <WithdrawForm card={card} back={back} canWrite={canWrite} />
    </article>
  );
}
