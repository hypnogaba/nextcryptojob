import Link from "next/link";
import type { ReactNode } from "react";
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
import type { CandidateSummary } from "@/lib/crm/types";
import { CARD, Chip } from "./ui";

/**
 * Рядок результату пошуку (W2): мітка, головна роль з балом і рівнем, інші
 * ролі, позначки, місце, мережі, зарплатна межа, режим контакту, дія.
 * Лише поля анонімного профілю (5.3). Без хуків: працює і на сервері, і в клієнті.
 * Посилання на профіль без попереднього завантаження: кожен перегляд профілю
 * витрачає квоту get_candidate і пишеться в журнал.
 */
export function CandidateRow({ c, action, roleParam }: { c: CandidateSummary; action?: ReactNode; roleParam?: string }) {
  const h = c.headline;
  const others = c.roles.filter((r) => r.role !== h.role);
  const place = [workText(c.work), c.chains.map((x) => CHAIN_TEXT[x]).join(", "), onchainYearsText(c.onchain_years)].filter(Boolean);
  const badges = badgeTexts(c.badges);
  const salary = salaryText(c.salary_floor);
  const href = `/company/candidates/${c.candidate_id}${roleParam ? `?role=${roleParam}` : ""}`;
  return (
    <article className={`${CARD} grid gap-2 p-4`} aria-labelledby={`cand-${c.candidate_id}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link
          id={`cand-${c.candidate_id}`}
          href={href}
          prefetch={false}
          className="font-mono text-base font-semibold text-ink underline-offset-4 hover:underline"
        >
          {c.label}
        </Link>
        {h.score !== null ? (
          <span className="text-sm text-ink">
            <span className="font-semibold">{roleScoreText(h)}</span>
            <span className="text-ink-muted">
              {" "}
              · Level {h.level} · Coverage {h.coverage ?? 0}%
            </span>
          </span>
        ) : (
          <span className="text-sm text-ink-muted">{unscoredText(h.role, h.unscored_reason)}</span>
        )}
      </div>
      {others.length ? (
        <p className="flex flex-wrap items-center gap-1.5 text-sm text-ink-muted">
          <span>Also:</span>
          {others.map((r) => (
            <Chip key={r.role}>{roleScoreText(r)}</Chip>
          ))}
        </p>
      ) : null}
      <p className="text-sm text-ink">{place.join(" · ")}</p>
      {badges.length ? <p className="text-sm text-ink-muted">{badges.join(" · ")}</p> : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink-muted">{[salary, contactModeText(c.contact_mode)].filter(Boolean).join(" · ")}</p>
        {action}
      </div>
    </article>
  );
}
