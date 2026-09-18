import Link from "next/link";
import type { ReactNode } from "react";
import { POS, ScoreChip } from "@/components/board";
import {
  badgeTexts,
  CHAIN_TEXT,
  contactModeText,
  onchainYearsText,
  roleScoreText,
  salaryText,
  unscoredText,
  workText,
} from "@/lib/crm/labels";
import type { Signal } from "@/lib/crm/signals";
import type { CandidateSummary } from "@/lib/crm/types";
import { POSITION_CODE } from "@/lib/roles/recipes";
import { cn } from "@/lib/utils";

/** Місце під фішку, коли балу немає: той самий розмір, пунктир. */
export function EmptyChip({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn("inline-block aspect-[0.718] w-11 shrink-0 rounded-[4.55%/3.5%] border border-dashed border-line-strong", className)}
    />
  );
}

/**
 * Рядок результату пошуку (W2) у голосі дошки скаута: фішка з балом і обробкою
 * рівня, мітка, код позиції, бал і рівень словами, інші ролі, місце, мережі,
 * позначки, зарплатна межа, режим контакту, дія. Лише поля анонімного профілю (5.3).
 * Без хуків: працює і на сервері, і в клієнті. Посилання на профіль без
 * попереднього завантаження: кожен перегляд профілю витрачає квоту get_candidate
 * і пишеться в журнал.
 */
export function CandidateRow({
  c,
  action,
  roleParam,
  signals,
  fit,
}: {
  c: CandidateSummary;
  action?: ReactNode;
  roleParam?: string;
  /** Сильні сторони для ролі рядка (lib/crm/signals.ts): «GitHub 94», «X 71». */
  signals?: Signal[];
  /** Шортлист: чому людина підходить під бриф (lib/crm/brief.ts fitReasons). */
  fit?: string[];
}) {
  const h = c.headline;
  const others = c.roles.filter((r) => r.role !== h.role);
  const place = [workText(c.work), c.chains.map((x) => CHAIN_TEXT[x]).join(", "), onchainYearsText(c.onchain_years)].filter(Boolean);
  const badges = badgeTexts(c.badges);
  const salary = salaryText(c.salary_floor);
  const href = `/company/candidates/${c.candidate_id}${roleParam ? `?role=${roleParam}` : ""}`;
  return (
    <article
      className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 px-4 py-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:px-5"
      aria-labelledby={`cand-${c.candidate_id}`}
    >
      {h.score !== null ? <ScoreChip score={h.score} level={h.level} /> : <EmptyChip />}
      <div className="grid min-w-0 content-start gap-1">
        <p className="flex flex-wrap items-baseline gap-x-3">
          <Link
            id={`cand-${c.candidate_id}`}
            href={href}
            prefetch={false}
            className="font-mono text-base font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand"
          >
            {c.label}
          </Link>
          <span className={POS}>{POSITION_CODE[h.role]}</span>
        </p>
        {h.score !== null ? (
          <p className="text-sm text-ink">
            <span className="font-semibold">{roleScoreText(h)}</span>
            <span className="text-ink-muted">
              {" "}
              · Level {h.level} · Coverage {h.coverage ?? 0}%
            </span>
          </p>
        ) : (
          <p className="text-sm text-ink-muted">{unscoredText(h.role, h.unscored_reason)}</p>
        )}
        {signals?.length ? (
          <ul aria-label="Top signals" className="mt-1 flex flex-wrap gap-1.5" data-signals="">
            {signals.map((s) => (
              <li key={s.label} className="rounded border border-line bg-wash px-1.5 py-0.5 text-xs text-ink">
                {s.label} <b className="tabular-nums">{s.value}</b>
              </li>
            ))}
          </ul>
        ) : null}
        {fit?.length ? (
          <p className="mt-1 text-sm text-ink" data-fit="">
            <span className="font-semibold">Why they fit:</span> {fit.join(" · ")}
          </p>
        ) : null}
        {others.length ? <p className="text-sm text-ink-muted">Also: {others.map(roleScoreText).join(", ")}</p> : null}
        <p className="mt-1 text-sm text-ink">{place.join(" · ")}</p>
        {badges.length ? <p className="text-sm text-ink-muted">{badges.join(" · ")}</p> : null}
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted">
          {salary ? <span>{salary}</span> : null}
          {c.contact_mode === "direct" ? (
            // Кандидат сам увімкнув «Telegram handle directly»: компанія бачить нік одразу, без запиту.
            <span data-contact="direct" className="rounded border border-brand px-1.5 py-0.5 text-xs font-semibold text-ink">
              {contactModeText("direct")}
            </span>
          ) : (
            <span data-contact="approval">{contactModeText("approval")}</span>
          )}
        </p>
      </div>
      {action ? <div className="col-start-2 sm:col-start-3 sm:row-start-1 sm:self-center">{action}</div> : null}
    </article>
  );
}
