// Приклад картки на головній. Цифри вигадані й підписані як приклад;
// рівень рахується за правилом з docs/contracts.md: min(10, floor(score/10) + 1).
const SAMPLE = {
  role: "Engineer",
  score: 78,
  sources: [
    { label: "GitHub", value: 84 },
    { label: "X", value: 61 },
    { label: "Onchain", value: 92 },
  ],
} as const;

export function SampleScoreCard() {
  const level = Math.min(10, Math.floor(SAMPLE.score / 10) + 1);

  return (
    <figure
      aria-label={`Example score card: ${SAMPLE.role}, score ${SAMPLE.score} of 100`}
      className="rounded-xl border border-line bg-surface p-5 shadow-[0_1px_2px_rgb(20_26_27/4%),0_16px_40px_-24px_rgb(20_26_27/25%)] sm:p-6"
    >
      <div className="flex items-center justify-between font-mono text-xs tracking-widest text-ink-muted uppercase">
        <span>{SAMPLE.role}</span>
        <span>Example</span>
      </div>

      <div className="mt-6 flex items-end justify-between gap-4">
        <p className="font-mono text-6xl leading-none font-medium tabular-nums text-ink">
          {SAMPLE.score}
          <span className="ml-1 text-base text-ink-muted">/100</span>
        </p>
        <p className="rounded-md bg-brand-soft px-2 py-1 font-mono text-xs font-medium text-brand">
          Level {level}
        </p>
      </div>

      <ul className="mt-6 space-y-3">
        {SAMPLE.sources.map((source) => (
          <li key={source.label} className="grid grid-cols-[4.5rem_1fr_2rem] items-center gap-3">
            <span className="font-mono text-xs text-ink-muted">{source.label}</span>
            <span className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden="true">
              <span
                className="block h-full rounded-full bg-brand"
                style={{ width: `${source.value}%` }}
              />
            </span>
            <span className="text-right font-mono text-xs tabular-nums text-ink">{source.value}</span>
          </li>
        ))}
      </ul>
    </figure>
  );
}
