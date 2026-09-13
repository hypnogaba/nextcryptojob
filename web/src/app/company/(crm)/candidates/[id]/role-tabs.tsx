"use client";

import Link from "next/link";
import { useRef, useState, type KeyboardEvent } from "react";
import { LINK, ScoreBar } from "@/components/crm/ui";
import { roleText, unscoredText } from "@/lib/crm/labels";
import type { RoleScoreDetailed } from "@/lib/crm/types";
import { cn } from "@/lib/utils";

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

/**
 * Вкладки ролей з поясненням балу по джерелах (W3): смужки 0–100, вага ядра,
 * максимум додатку, прогалини даних. Лише бали джерел: сирих фактів тут немає.
 * Вкладки з клавіатури: стрілки, Home, End (WAI-ARIA Tabs).
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
  return (
    <div className="grid gap-4">
      <div role="tablist" aria-label="Roles" onKeyDown={onKey} className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1">
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
              "inline-flex min-h-11 shrink-0 items-center gap-2 rounded-md border px-3 text-sm font-medium",
              i === active ? "border-brand bg-brand-soft text-ink" : "border-line bg-surface text-ink-muted hover:bg-wash hover:text-ink",
            )}
          >
            {roleText(role.role)}
            <span className="font-mono tabular-nums">{role.score ?? "n/a"}</span>
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${r.role}`} aria-labelledby={`tab-${r.role}`} tabIndex={0} className="grid gap-4">
        {r.score === null ? <p className="text-sm text-ink">{unscoredText(r.role, r.unscored_reason)}</p> : null}
        {r.breakdown ? (
          <>
            <table className="w-full text-sm">
              <caption className="sr-only">Score breakdown for {roleText(r.role)}</caption>
              <thead>
                <tr className="text-left text-ink-muted">
                  <th scope="col" className="py-1 font-medium">
                    Core
                  </th>
                  <th scope="col" className="w-16 py-1 text-right font-medium">
                    Weight
                  </th>
                  <th scope="col" className="py-1 pl-3 font-medium">
                    Score
                  </th>
                </tr>
              </thead>
              <tbody>
                {r.breakdown.core.map((c) => (
                  <tr key={c.source} className="border-t border-line">
                    <th scope="row" className="py-2 pr-2 text-left font-normal text-ink">
                      {c.label}
                    </th>
                    <td className="py-2 text-right font-mono tabular-nums text-ink-muted">{c.weight}</td>
                    <td className="py-2 pl-3">
                      <ScoreBar value={c.value} label={c.label} />
                    </td>
                  </tr>
                ))}
              </tbody>
              {r.breakdown.bonus.length ? (
                <tbody>
                  <tr>
                    <th scope="colgroup" colSpan={3} className="pt-3 pb-1 text-left font-medium text-ink-muted">
                      Bonus (up to +{r.breakdown.bonus.reduce((a, b) => a + b.max, 0)})
                    </th>
                  </tr>
                  {r.breakdown.bonus.map((b) => (
                    <tr key={b.source} className="border-t border-line">
                      <th scope="row" className="py-2 pr-2 text-left font-normal text-ink">
                        {b.label}
                      </th>
                      <td className="py-2 text-right font-mono tabular-nums text-ink-muted">max +{b.max}</td>
                      <td className="py-2 pl-3">
                        <ScoreBar value={b.value} label={b.label} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              ) : null}
            </table>
            {r.breakdown.gaps.length ? (
              <p className="text-sm text-ink-muted">Data gaps: {r.breakdown.gaps.map((g) => g.label).join("; ")}</p>
            ) : null}
            <p className="text-xs text-ink-muted">
              Updated {DATE.format(new Date(r.breakdown.updated_at))} · Formula {r.breakdown.formula_version} ·{" "}
              <Link href="/how-scoring-works" className={LINK}>
                How scores work
              </Link>
            </p>
          </>
        ) : r.score !== null ? null : (
          <p className="text-xs text-ink-muted">
            <Link href="/how-scoring-works" className={LINK}>
              How scores work
            </Link>
          </p>
        )}
      </div>
    </div>
  );
}
