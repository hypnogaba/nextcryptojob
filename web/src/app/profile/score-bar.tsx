import type { SourceBar } from "@/lib/score/explain";

/** Одне джерело балу: назва, вага і смужка 0–100. */
export function ScoreBar({ bar, weightLabel }: { bar: SourceBar; weightLabel: string }) {
  return (
    <li className="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-1.5">
      <span className="text-sm text-ink">
        {bar.label} <span className="font-mono text-xs text-ink-muted">{weightLabel}</span>
      </span>
      <span className="font-mono text-sm text-ink">{bar.value === null ? "No data" : bar.value}</span>
      <span
        aria-hidden
        className={`col-span-2 h-1.5 overflow-hidden rounded-full ${bar.value === null ? "border border-dashed border-line-strong" : "bg-wash"}`}
      >
        {bar.value !== null ? (
          <span className="block h-full rounded-full bg-brand" style={{ width: `${Math.max(2, bar.value)}%` }} />
        ) : null}
      </span>
    </li>
  );
}
