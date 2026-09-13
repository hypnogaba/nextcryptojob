"use client";

import Link from "next/link";
import { useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { LINK } from "@/components/crm/ui";
import { levelFor, tierFor, tierVars } from "@/lib/card/tiers";
import { roleText, unscoredText } from "@/lib/crm/labels";
import type { RoleScoreDetailed, ScoreBreakdown } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * Зворот картки ролі очима компанії: джерело, вага, бал джерела, покриття й
 * рейтинг, у рамці з обробкою рівня. Компанії важать докази, тож показуємо
 * зворот одразу. Стовпця балів рядка немає: CRM отримує цілі бали джерел
 * (project.ts breakdownOf), і сума з них не завжди дорівнювала б рейтингу.
 */
function RoleBack({ role, score, breakdown }: { role: RoleScoreDetailed; score: number | null; breakdown: ScoreBreakdown }) {
  // Без балу рівня немає: проста паперова рамка першого рівня.
  const tier = tierFor(score === null ? 1 : (role.level ?? levelFor(score)));
  const name = roleText(role.role);
  return (
    <div className="ncj-sheet max-w-[26rem]">
      <div className="ncj-face ncj-back" style={tierVars(tier) as CSSProperties}>
        <h3>{score === null ? `${name}, not scored` : `${name}, rated ${score}`}</h3>
        <p>
          How the score was built. Formula {breakdown.formula_version}, updated {DATE.format(new Date(breakdown.updated_at))}.
        </p>
        <table>
          <caption className="sr-only">Score breakdown for {name}: source, weight and source score</caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Weight</th>
              <th scope="col">Value</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.core.map((c) => (
              <tr key={c.source}>
                <th scope="row">{c.label}</th>
                <td>{c.weight}</td>
                <td>{c.value ?? "none"}</td>
              </tr>
            ))}
            {breakdown.bonus.map((b) => (
              <tr key={b.source}>
                <th scope="row">{b.label}</th>
                <td>+{b.max}</td>
                <td>{b.value ?? "none"}</td>
              </tr>
            ))}
            {score !== null || role.coverage !== null ? (
              <tr className="ncj-sum">
                <th scope="row">Cover</th>
                <td />
                <td>{role.coverage ?? 0}%</td>
              </tr>
            ) : null}
            {score !== null ? (
              <tr className="ncj-total">
                <th scope="row">Rating</th>
                <td />
                <td>{score}</td>
              </tr>
            ) : null}
          </tbody>
        </table>
        {breakdown.gaps.length ? <p>Data gaps: {breakdown.gaps.map((g) => g.label).join("; ")}.</p> : null}
        <p className="ncj-legend">
          Weight is the share of 100 for a core source; +N is the most a bonus adds. Value is the source score, 0 to 100. A source
          without data shows none, not 0.
        </p>
      </div>
    </div>
  );
}

/**
 * Вкладки ролей (W3) і зворот картки вибраної ролі. Лише бали джерел: сирих
 * фактів тут немає. Вкладки з клавіатури: стрілки, Home, End (WAI-ARIA Tabs).
 */
export function RoleTabs({ roles, initial }: { roles: RoleScoreDetailed[]; initial: string | null }) {
  const start = Math.max(0, roles.findIndex((r) => r.role === initial));
  const [active, setActive] = useState(start);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    const last = roles.length - 1;
    const next =
      e.key === "ArrowRight" ? (active === last ? 0 : active + 1) : e.key === "ArrowLeft" ? (active === 0 ? last : active - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    tabs.current[next]?.focus();
  }

  if (roles.length === 0) return <p className="text-sm text-ink-muted">The candidate has not chosen a role yet.</p>;
  const r = roles[active];
  const howLink = (
    <Link href="/how-scoring-works" className={LINK}>
      How scores work
    </Link>
  );
  return (
    <div className="grid gap-4">
      <div role="tablist" aria-label="Roles" onKeyDown={onKey} className="-mx-1 flex gap-2 overflow-x-auto px-1 pt-1 pb-1">
        {roles.map((role, i) => (
          <button
            key={role.role}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`tab-${role.role}`}
            aria-selected={i === active}
            aria-controls={`panel-${role.role}`}
            tabIndex={i === active ? 0 : -1}
            onClick={() => setActive(i)}
            className={cn(
              "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-lg border bg-surface px-3 text-sm font-semibold transition-colors",
              i === active ? "border-ink text-ink shadow-[inset_0_0_0_1px_var(--ink)]" : "border-line text-ink-muted hover:border-line-strong hover:text-ink",
            )}
          >
            {roleText(role.role)}
            <span className="font-display text-lg leading-none font-black tabular-nums">{role.score ?? "n/a"}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${r.role}`} aria-labelledby={`tab-${r.role}`} tabIndex={0} className="grid justify-items-start gap-3">
        {r.score === null ? <p className="text-sm text-ink">{unscoredText(r.role, r.unscored_reason)}</p> : null}
        {r.breakdown ? <RoleBack role={r} score={r.score} breakdown={r.breakdown} /> : null}
        {r.breakdown || r.score === null ? <p className="text-sm text-ink-muted">{howLink}: what each source score means.</p> : null}
      </div>
    </div>
  );
}
