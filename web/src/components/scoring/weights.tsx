import { Fragment } from "react";
import { BOARD, POS, TABLE, TD, TH, TR } from "@/components/board";
import { ROLES } from "@/lib/card/roles";
import { POSITION_CODE, RECIPES, SCORED_ROLE_KEYS, SOURCE_NAME, type SourceKey } from "@/lib/roles/recipes";
import { COMBINED_SOURCES, SOURCE_PARTS, WEIGHT_COLUMNS } from "@/lib/roles/source-parts";
import { cn } from "@/lib/utils";

/**
 * Усі ваги формули на одній сторінці (власник 16.09, c5): роль × джерело, і з чого складається
 * кожне джерело. Ончейн окремою підсвіченою колонкою: власнику важливо, скільки вона важить.
 */

const ONCHAIN_COL = "bg-brand-soft";
const NUM = "text-right tabular-nums whitespace-nowrap";

type Row = { key: string; label: string; code: string; core: Map<SourceKey, number>; bonus: Map<SourceKey, number> };

function rows(): Row[] {
  return SCORED_ROLE_KEYS.flatMap((role) => {
    const r = RECIPES[role];
    const bonus = new Map<SourceKey, number>(r.bonus.map(([k, n]) => [k, n]));
    return r.paths.map((path, i) => ({
      key: `${role}-${i}`,
      label: r.paths.length === 1 ? ROLES[role].name : `${ROLES[role].name}, ${i === 0 ? "with audit contests" : "without them"}`,
      code: POSITION_CODE[role],
      core: new Map<SourceKey, number>(path.map(([k, n]) => [k, n])),
      bonus,
    }));
  });
}

function Cell({ core, bonus }: { core?: number; bonus?: number }) {
  if (core) return <span className="font-semibold text-ink">{core}</span>;
  if (bonus) return <span className="text-ink-muted">+{bonus}</span>;
  return (
    <>
      <span aria-hidden="true" className="text-line-strong">
        ·
      </span>
      <span className="sr-only">not used</span>
    </>
  );
}

export function WeightsTable() {
  return (
    <div className={BOARD}>
      <table className={TABLE} data-table="weights">
        <caption className="px-4 pt-3 pb-1 text-left text-sm text-ink-muted">
          Main part out of 100, and bonus points (+) that only add. Onchain is highlighted.
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
                  <Cell core={r.core.get(k)} bonus={r.bonus.get(k)} />
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
          {SOURCE_NAME.media} and {SOURCE_NAME.output}
        </h3>
        <p className="text-sm text-ink">
          <b>{SOURCE_NAME.media}:</b> {COMBINED_SOURCES.media}
        </p>
        <p className="text-sm text-ink">
          <b>{SOURCE_NAME.output}:</b> {COMBINED_SOURCES.output}
        </p>
      </section>
    </div>
  );
}
