"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { CandidateRow } from "@/components/crm/candidate-row";
import { LINK, StageChip } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
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
}: {
  companyId: string;
  /** Рядок адреси пошуку (фільтри + сортування), для наступних сторінок. */
  query: string;
  initial: SearchResponse;
  role?: string;
  canWrite: boolean;
}) {
  const [items, setItems] = useState<CandidateSummary[]>(initial.data);
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
      <ol className="grid gap-3">
        {items.map((c) => (
          <li key={c.candidate_id}>
            <CandidateRow
              c={c}
              roleParam={role}
              action={
                c.pipeline ? (
                  <Link href="/company/pipeline" className="inline-flex min-h-11 items-center gap-2 text-sm text-ink-muted">
                    In pipeline: <StageChip stage={c.pipeline.stage} />
                  </Link>
                ) : canWrite ? (
                  <AddButton companyId={companyId} candidate={c} role={role} onAdded={(p) => setStage(c.candidate_id, p)} />
                ) : null
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
    <div className="grid justify-items-end gap-1">
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
