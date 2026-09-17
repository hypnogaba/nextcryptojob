import Link from "next/link";
import { NUM } from "@/components/admin-ui";
import { bucketLabel, VISIT_BUCKETS, type VisitBucket, type VisitSeries } from "@/lib/analytics/visits";
import { cn } from "@/lib/utils";

/**
 * Графік відвідувань без жодної бібліотеки: SVG прямо в розмітці, тож нічого не вантажиться
 * у браузер і на сервері він рендериться разом зі сторінкою.
 *
 * Що видно: стовпчики унікальних відвідувачів (ліва вісь), лінія переглядів (права вісь, свій
 * масштаб: переглядів завжди в кілька разів більше), і число реєстрацій над стовпчиком, коли
 * вони були. Сітка з підписаними числами, підписи під стовпчиками, і підказка на кожному
 * стовпчику з усіма трьома числами.
 *
 * Унікальний відвідувач рахується за добу, тож тиждень і місяць це сума днів: та сама людина
 * два дні поспіль дасть 2. Так і підписано під графіком, щоб цифра не здавалась «людьми».
 */

const W = 720;
const H = 240;
const PAD = { top: 18, right: 46, bottom: 30, left: 44 };
const PLOT_W = W - PAD.left - PAD.right;
const PLOT_H = H - PAD.top - PAD.bottom;

/** Кругле число для верху осі: 1, 2 або 5 на порядок вище за найбільше значення. */
export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const top = step * pow;
    if (value <= top) return top;
  }
  return 10 * pow;
}

const tick = (max: number, i: number): number => (max * i) / 4;

/** Скільки підписів під віссю: 30 днів не вміщаються, тож кожен n-й. */
function labelEvery(count: number): number {
  if (count <= 12) return 1;
  if (count <= 20) return 2;
  return Math.ceil(count / 10);
}

export function VisitsChart({ series }: { series: VisitSeries }) {
  const points = series.points;
  const topUniques = niceMax(Math.max(...points.map((p) => p.uniques), 0));
  const topViews = niceMax(Math.max(...points.map((p) => p.views), 0));
  const band = PLOT_W / Math.max(1, points.length);
  const barW = Math.max(3, Math.min(30, band * 0.6));
  const every = labelEvery(points.length);
  const x = (i: number) => PAD.left + band * (i + 0.5);
  const yV = (v: number) => PAD.top + PLOT_H - (v / topViews) * PLOT_H;
  const viewLine = points.map((p, i) => `${x(i).toFixed(1)},${yV(p.views).toFixed(1)}`).join(" ");
  const step = bucketLabel(series.bucket);

  return (
    <div className="grid gap-3">
      <svg
        viewBox={`0 0 ${W} ${H}`}
        width="100%"
        height={H}
        role="img"
        aria-label={`Unique visitors and page views per ${step}`}
        className="max-w-full overflow-visible"
      >
        {[0, 1, 2, 3, 4].map((i) => {
          const y = PAD.top + PLOT_H - (PLOT_H * i) / 4;
          return (
            <g key={i}>
              <line x1={PAD.left} x2={W - PAD.right} y1={y} y2={y} className="stroke-line" strokeWidth={1} />
              <text x={PAD.left - 6} y={y + 3.5} textAnchor="end" className="fill-ink-muted text-[10px] tabular-nums">
                {NUM.format(Math.round(tick(topUniques, i)))}
              </text>
              <text x={W - PAD.right + 6} y={y + 3.5} className="fill-ink-muted text-[10px] tabular-nums">
                {NUM.format(Math.round(tick(topViews, i)))}
              </text>
            </g>
          );
        })}

        {points.map((p, i) => {
          const h = Math.max(p.uniques > 0 ? 2 : 0, (p.uniques / topUniques) * PLOT_H);
          return (
            <g key={p.key} data-point={p.key}>
              <rect
                x={x(i) - barW / 2}
                y={PAD.top + PLOT_H - h}
                width={barW}
                height={h}
                rx={2}
                className="fill-brand/25"
              />
              {p.signups > 0 ? (
                <text
                  x={x(i)}
                  y={PAD.top + PLOT_H - h - 5}
                  textAnchor="middle"
                  className="fill-ink text-[10px] font-semibold tabular-nums"
                >
                  +{NUM.format(p.signups)}
                </text>
              ) : null}
              {/* Прозорий прямокутник на всю висоту: підказка спрацьовує будь-де над стовпчиком. */}
              <rect x={PAD.left + band * i} y={PAD.top} width={band} height={PLOT_H} fill="transparent">
                <title>
                  {`${p.title}: ${NUM.format(p.uniques)} unique visitors, ${NUM.format(p.views)} views, ${NUM.format(p.signups)} sign-ups`}
                </title>
              </rect>
              {i % every === 0 || i === points.length - 1 ? (
                <text x={x(i)} y={H - 10} textAnchor="middle" className="fill-ink-muted text-[10px]">
                  {p.label}
                </text>
              ) : null}
            </g>
          );
        })}

        <polyline points={viewLine} fill="none" strokeWidth={1.75} className="stroke-ink" />
        {points.map((p, i) => (
          <circle key={p.key} cx={x(i)} cy={yV(p.views)} r={2} className="fill-ink" />
        ))}
      </svg>

      <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-ink-muted">
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-2.5 w-3 rounded-sm bg-brand/25" />
          Unique visitors, left axis
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span aria-hidden className="inline-block h-0.5 w-4 bg-ink" />
          Page views, right axis
        </span>
        <span className="inline-flex items-center gap-1.5">
          <b className="text-ink">+n</b>
          Sign-ups that {step}
        </span>
        <span>A visitor is counted once a {step === "day" ? "day" : `day, so a ${step} is the sum of its days`}.</span>
      </p>
    </div>
  );
}

/** Перемикач кроку: дні, тижні, місяці. `base` це адреса сторінки, решта запиту зберігається. */
export function BucketTabs({
  base,
  current,
  param = "step",
  extra,
}: {
  base: string;
  current: VisitBucket;
  param?: string;
  extra?: Record<string, string>;
}) {
  const href = (b: VisitBucket): string => {
    const q = new URLSearchParams({ ...(extra ?? {}), [param]: b });
    return `${base}?${q.toString()}`;
  };
  return (
    <nav aria-label="Chart step" className="flex flex-wrap gap-3 text-sm">
      {VISIT_BUCKETS.map((b) => (
        <Link
          key={b}
          href={href(b)}
          aria-current={b === current ? "page" : undefined}
          data-step={b}
          className={cn(
            "inline-flex min-h-11 items-center border-b-2 px-1 font-semibold",
            b === current ? "border-ink text-ink" : "border-transparent text-ink-muted hover:border-line-strong hover:text-ink",
          )}
        >
          {b === "day" ? "Days" : b === "week" ? "Weeks" : "Months"}
        </Link>
      ))}
    </nav>
  );
}
