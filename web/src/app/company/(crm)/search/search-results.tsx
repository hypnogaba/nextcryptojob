"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { CandidateRow } from "@/components/crm/candidate-row";
import { LINK, StageText } from "@/components/crm/ui";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Signal } from "@/lib/crm/signals";
import type { CandidateSummary, SearchResponse } from "@/lib/crm/types";
import { addFromSearchAction, loadMoreAction } from "./actions";

/**
 * Список результатів пошуку з "Load more" і "Add to pipeline" (W2). Перша
 * сторінка приходить із сервера; наступні додаються знизу без перезавантаження.
 */
export function SearchResults({
  companyId,
  query,
  initial,
  role,
  canWrite,
  signals: initialSignals = {},
}: {
  companyId: string;
  /** Рядок адреси пошуку (фільтри + сортування), для наступних сторінок. */
  query: string;
  initial: SearchResponse;
  role?: string;
  canWrite: boolean;
  /** Сильні сторони за `${id}:${роль}` (lib/crm/signals.ts). */
  signals?: Record<string, Signal[]>;
}) {
  const [items, setItems] = useState<CandidateSummary[]>(initial.data);
  const [signals, setSignals] = useState<Record<string, Signal[]>>(initialSignals);
  const [cursor, setCursor] = useState<string | null>(initial.next_cursor);
  const [capReached, setCapReached] = useState(Boolean(initial.page_cap_reached));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function loadMore() {
    if (!cursor) return;
    setError(null);
    startTransition(async () => {
      const res = await loadMoreAction({ companyId, query, cursor });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setItems((prev) => [...prev, ...res.page.data.filter((d) => !prev.some((p) => p.candidate_id === d.candidate_id))]);
      setSignals((prev) => ({ ...prev, ...res.signals }));
      setCursor(res.page.next_cursor);
      setCapReached(Boolean(res.page.page_cap_reached));
    });
  }

  function setStage(id: string, stage: CandidateSummary["pipeline"]) {
    setItems((prev) => prev.map((c) => (c.candidate_id === id ? { ...c, pipeline: stage } : c)));
  }

  return (
    <div className="grid gap-3">
      <p className="text-sm text-ink-muted" aria-live="polite">
        {items.length} {items.length === 1 ? "candidate" : "candidates"} shown
      </p>
      <ol className="overflow-hidden rounded-[10px] border-[1.5px] border-line bg-surface">
        {items.map((c) => (
          <li key={c.candidate_id} className="border-b border-line last:border-b-0 hover:bg-brand-soft">
            <CandidateRow
              c={c}
              roleParam={role}
              signals={signals[`${c.candidate_id}:${c.headline.role}`]}
              action={
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 sm:justify-end">
                  {canWrite ? <IntroLink c={c} role={role} /> : null}
                  {c.pipeline ? (
                    <Link href="/company/pipeline" className="inline-flex min-h-11 items-center gap-1.5 text-sm text-ink-muted hover:text-ink">
                      In pipeline: <StageText stage={c.pipeline.stage} />
                    </Link>
                  ) : canWrite ? (
                    <AddButton companyId={companyId} candidate={c} role={role} onAdded={(p) => setStage(c.candidate_id, p)} />
                  ) : null}
                </div>
              }
            />
          </li>
        ))}
      </ol>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      {cursor ? (
        <div className="flex justify-center">
          <Button type="button" variant="outline" className="h-11 px-5 text-base" onClick={loadMore} disabled={pending} aria-busy={pending || undefined}>
            {pending ? "Loading..." : "Load more"}
          </Button>
        </div>
      ) : capReached ? (
        <p className="text-center text-sm text-ink-muted">
          You reached the end of this search (200 results). Narrow the filters to see others.
        </p>
      ) : items.length > 0 ? (
        <p className="text-center text-sm text-ink-muted">
          That is everyone who matches these filters.{" "}
          <Link href="/company/saved-searches" className={LINK}>
            Saved searches
          </Link>{" "}
          tell you about new matches.
        </p>
      ) : null}
    </div>
  );
}

/**
 * «Intro» з рядка: профіль кандидата з відкритим діалогом знайомства. Для «Telegram handle
 * directly» кнопка каже, що нік видно одразу. Без попереднього завантаження: показ профілю
 * витрачає перегляд з денної квоти.
 */
function IntroLink({ c, role }: { c: CandidateSummary; role?: string }) {
  const direct = c.contact_mode === "direct";
  const stage = c.pipeline?.stage;
  if (stage === "intro_requested" || stage === "contact_shared" || stage === "interview" || stage === "hired") return null;
  const href = `/company/candidates/${c.candidate_id}?${role ? `role=${role}&` : ""}intro=1`;
  return (
    <Link
      href={href}
      prefetch={false}
      className={cn(buttonVariants({ variant: "default" }), "h-11 px-4 text-sm")}
    >
      {direct ? "Show Telegram" : "Request intro"}
    </Link>
  );
}

function AddButton({
  companyId,
  candidate,
  role,
  onAdded,
}: {
  companyId: string;
  candidate: CandidateSummary;
  role?: string;
  onAdded: (p: CandidateSummary["pipeline"]) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="grid justify-items-start gap-1 sm:justify-items-end">
      <Button
        type="button"
        variant="outline"
        className="h-11 px-4 text-sm"
        disabled={pending}
        aria-busy={pending || undefined}
        aria-describedby={error ? `add-error-${candidate.candidate_id}` : undefined}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await addFromSearchAction({ companyId, candidateId: candidate.candidate_id, role: role ?? candidate.headline.role });
            if (res.ok) onAdded({ stage: res.stage, tags: res.tags });
            else setError(res.error);
          })
        }
      >
        {pending ? "Adding..." : "Add to pipeline"}
      </Button>
      {error ? (
        <p id={`add-error-${candidate.candidate_id}`} role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}
