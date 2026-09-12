import type { CardView } from "@/lib/card/view";

// Картка балу на сторінці /c/<slug>. Та сама композиція, що й картинка для X
// (lib/card/og.tsx): колір ступеня з візерунком, плашка з текстом. Плашка йде
// за темою сайту, дрібний текст на кольорі ступеня стоїть лише на `base`.
export function ScoreCard({ view }: { view: CardView }) {
  const { backgroundColor, backgroundImage } = view.background;

  return (
    <figure
      aria-label={view.summary}
      className="rounded-2xl p-3 shadow-[0_1px_2px_rgb(20_26_27/4%),0_16px_40px_-24px_rgb(20_26_27/25%)] sm:p-5"
      style={{
        backgroundColor,
        // Візерунок поверх кольору ступеня; data: пускає CSP (img-src data:).
        backgroundImage: [`url("${view.patternSrc}")`, backgroundImage].filter(Boolean).join(", "),
        backgroundSize: "cover",
        backgroundPosition: "right center",
      }}
    >
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <div aria-hidden="true" className="h-16 sm:hidden" />
        <div className="rounded-xl bg-surface p-6 text-ink sm:p-8">
          <p className="font-mono text-xs tracking-widest text-ink-muted uppercase">{view.roleName}</p>

          <p className="mt-6 flex items-end gap-2">
            <span className="font-heading text-7xl leading-none font-semibold tabular-nums sm:text-8xl">
              {view.score}
            </span>
            <span className="mb-1 font-mono text-base text-ink-muted">/100</span>
          </p>

          <p className="mt-5">
            <span
              className="inline-block rounded-md px-2 py-1 font-mono text-sm font-medium"
              style={{ backgroundColor: view.tier.base, color: view.tier.ink }}
            >
              {view.levelLabel}
            </span>
          </p>

          <h1 className="mt-8 truncate font-sans text-2xl font-semibold tracking-normal">{view.displayName}</h1>
        </div>
      </div>
    </figure>
  );
}
