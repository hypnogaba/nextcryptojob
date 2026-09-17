import { Fragment } from "react";
import { BOARD, POS, TABLE, TD, TH, TR } from "@/components/board";
import { ROLES } from "@/lib/card/roles";
import {
  POSITION_CODE, RECIPES, REP_POINTS, SCORED_ROLE_KEYS, SOURCE_NAME, type SourceKey, WIDTH_EACH, WIDTH_SOURCES, WORK_POINTS,
} from "@/lib/roles/recipes";
import { COMBINED_SOURCES, REPUTATION_TEXT, SOURCE_PARTS, WEIGHT_COLUMNS } from "@/lib/roles/source-parts";
import { cn } from "@/lib/utils";

/**
 * Усі ваги формули v7 на одній сторінці (власник 16.09, c5; 17.09 v7): бал = Робота + Репутація + Ширина.
 * Таблиця: роль × джерело, числа = бали «Роботи». Ончейн підсвічено: власнику важливо, скільки він важить.
 */

const ONCHAIN_COL = "bg-brand-soft";
const NUM = "text-right tabular-nums whitespace-nowrap";

type Row = { key: string; label: string; code: string; work: Map<SourceKey, number> };

function rows(): Row[] {
  return SCORED_ROLE_KEYS.flatMap((role) => {
    const r = RECIPES[role];
    return r.paths.map((path, i) => ({
      key: `${role}-${i}`,
      label: r.paths.length === 1 ? ROLES[role].name : `${ROLES[role].name}, ${i === 0 ? "with audit contests" : "without them"}`,
      code: POSITION_CODE[role],
      work: new Map<SourceKey, number>(path.map(([k, n]) => [k, n])),
    }));
  });
}

function Cell({ points }: { points?: number }) {
  if (points) return <span className="font-semibold text-ink">{points}</span>;
  return (
    <>
      <span aria-hidden="true" className="text-line-strong">
        ·
      </span>
      <span className="sr-only">not used</span>
    </>
  );
}

/** Три шари балу однією смугою. */
export function Layers() {
  const parts = [
    { name: "Work", points: WORK_POINTS, text: "Your role's main sources, below.", cls: "bg-ink text-white" },
    { name: "Reputation", points: REP_POINTS, text: REPUTATION_TEXT, cls: "bg-brand-soft text-ink" },
    {
      name: "Breadth",
      points: WIDTH_SOURCES * WIDTH_EACH,
      text: `Your ${WIDTH_SOURCES} strongest other sources, up to ${WIDTH_EACH} points each. Everything you connect can count.`,
      cls: "bg-soft text-ink",
    },
  ];
  return (
    <ol className="grid gap-3 sm:grid-cols-[60fr_25fr_15fr]" aria-label="Score layers">
      {parts.map((p) => (
        <li key={p.name} className={cn("grid content-start gap-1 rounded-2xl p-4", p.cls)}>
          <span className="font-display text-xl font-semibold">
            {p.name} <span className="tabular-nums">{p.points}</span>
          </span>
          <span className="text-sm opacity-80">{p.text}</span>
        </li>
      ))}
    </ol>
  );
}

export function WeightsTable() {
  return (
    <div className={BOARD}>
      <table className={TABLE} data-table="weights">
        <caption className="px-4 pt-3 pb-1 text-left text-sm text-ink-muted">
          Points of Work for each role, out of {WORK_POINTS}. Every role also gets Reputation (up to {REP_POINTS}) and Breadth (up to{" "}
          {WIDTH_SOURCES * WIDTH_EACH}). Onchain is highlighted.
        </caption>
        <thead>
          <tr>
            <th scope="col" className={TH}>
              Role
            </th>
            {WEIGHT_COLUMNS.map((k) => (
              <th key={k} scope="col" className={cn(TH, "text-right", k === "onchain" && ONCHAIN_COL)}>
                {SOURCE_NAME[k]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows().map((r) => (
            <tr key={r.key} className={TR}>
              <th scope="row" className={cn(TD, "text-left font-normal")}>
                <span className={cn(POS, "mr-2 inline-block w-10 text-base")}>{r.code}</span>
                {r.label}
              </th>
              {WEIGHT_COLUMNS.map((k) => (
                <td key={k} className={cn(TD, NUM, k === "onchain" && ONCHAIN_COL)}>
                  <Cell points={r.work.get(k)} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const SCALE: Record<"log" | "linear", string> = { log: "early steps count most", linear: "even steps" };

export function SourceParts() {
  const keys = Object.keys(SOURCE_PARTS) as (keyof typeof SOURCE_PARTS)[];
  // Ончейн першим: про нього питають найчастіше.
  const ordered = ["onchain" as const, ...keys.filter((k) => k !== "onchain")];
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {ordered.map((k) => (
        <section
          key={k}
          aria-labelledby={`src-${k}`}
          className={cn("grid content-start gap-2 rounded-3xl border-[1.5px] border-line p-5", k === "onchain" && "border-ink")}
        >
          <h3 id={`src-${k}`} className="font-display text-xl font-semibold">
            {SOURCE_NAME[k]}
          </h3>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1.5 text-sm">
            {SOURCE_PARTS[k].map((p) => (
              <Fragment key={p.label}>
                <dt className="text-ink">
                  {p.label}
                  {p.top ? (
                    <span className="block text-xs text-ink-muted">
                      Full at {p.top}
                      {p.scale ? `, ${SCALE[p.scale]}` : ""}
                    </span>
                  ) : null}
                </dt>
                <dd className={cn(NUM, "font-semibold")}>{p.weight}</dd>
              </Fragment>
            ))}
          </dl>
        </section>
      ))}
      <section aria-labelledby="src-combined" className="grid content-start gap-2 rounded-3xl bg-soft p-5">
        <h3 id="src-combined" className="font-display text-xl font-semibold">
          Combined sources
        </h3>
        {(["media", "output", "best"] as const).map((k) => (
          <p key={k} className="text-sm text-ink">
            <b>{SOURCE_NAME[k]}:</b> {COMBINED_SOURCES[k]}
          </p>
        ))}
        <p className="text-sm text-ink-muted">Audit contests and Dune are found by your GitHub or X; you do not add them.</p>
      </section>
    </div>
  );
}
