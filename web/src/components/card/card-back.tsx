import type { CardBack } from "@/lib/card/back";
import type { CardFace } from "@/lib/card/view";
import { cn } from "@/lib/utils";

const pts = (v: number) => v.toFixed(1);

/**
 * Розклад балу за формулою: панель поруч із карткою (з раунду 3 картка банківського
 * формату, і таблиця на її звороті не вміщалась). Джерело без даних друкується як
 * «none» і під ним причина. Нуль тут означає «дало 0 балів», а не «немає даних».
 */
export function CardBackFace({
  face,
  back,
  meta,
  missing,
  recipe,
  className,
}: {
  face: CardFace;
  back: CardBack | null;
  /** «Formula v6, checked 13 Sep 2026.» */
  meta: string;
  /** Чому розкладу немає. */
  missing?: string | null;
  /** Рецепт ролі словами: показуємо, коли розкладу немає. */
  recipe?: string | null;
  className?: string;
}) {
  return (
    <div className={cn("ncj-back", className)}>
      <h3>
        {face.roleName}, rated {face.score}
      </h3>
      <p>How the score was built. {meta}</p>
      {back ? (
        <table>
          <caption className="sr-only">
            Score breakdown for {face.roleName}: source, weight, value and points
          </caption>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Weight</th>
              <th scope="col">Value</th>
              <th scope="col">Points</th>
            </tr>
          </thead>
          <tbody>
            {back.lines.flatMap((l) => {
              const row = (
                <tr key={l.key}>
                  <th scope="row">
                    {l.name}
                  </th>
                  <td>{l.kind === "bonus" ? `+${l.weight}` : l.weight}</td>
                  <td>{l.value === null ? "none" : l.value.toFixed(1)}</td>
                  <td>{pts(l.points)}</td>
                </tr>
              );
              return l.reason
                ? [
                    row,
                    <tr key={`${l.key}-why`} className="ncj-gapnote">
                      <td colSpan={4}>none: {l.reason}</td>
                    </tr>,
                  ]
                : [row];
            })}
            <tr className="ncj-sum">
              <th scope="row">Core</th>
              <td />
              <td />
              <td>{pts(back.core)}</td>
            </tr>
            <tr className="ncj-sum">
              <th scope="row">Bonus</th>
              <td />
              <td />
              <td>{pts(back.bonus)}</td>
            </tr>
            <tr className="ncj-sum">
              <th scope="row">Cover</th>
              <td />
              <td />
              <td>{back.cover}%</td>
            </tr>
            <tr className="ncj-total">
              <th scope="row">Rating</th>
              <td />
              <td />
              <td>{face.score}</td>
            </tr>
          </tbody>
        </table>
      ) : (
        <div className="grid content-start gap-2">
          <p>{missing ?? "The breakdown for this card is not available."}</p>
          {recipe ? <p className="ncj-legend">{recipe}</p> : null}
        </div>
      )}
      {back?.note ? <p>{back.note}</p> : null}
      {back ? (
        <p className="ncj-legend">
          Points = weight × value / 100. A source without data shows its value as none, not as 0.
        </p>
      ) : null}
    </div>
  );
}
