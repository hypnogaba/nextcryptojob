import type { CSSProperties } from "react";
import { underprintDataUri } from "@/lib/card/seal";
import { tierVars } from "@/lib/card/tiers";
import type { CardFace } from "@/lib/card/view";
import { cn } from "@/lib/utils";
import { Seal } from "./seal";

// Хвилі підкладки під печаткою, ледь помітні: темні на світлому полі, світлі на чорному.
const UNDERPRINT_ON_PAPER = underprintDataUri("#5d6166", 0.2);
const UNDERPRINT_ON_BLACK = underprintDataUri("#a9adb2", 0.16);

/**
 * Лицьовий бік картки: бал, код позиції, рівень і обробка, печатка, ім'я,
 * до шести джерел з «gap» замість нуля, рядок сезону й номера.
 * EXAMPLE з'являється лише на face.kind === "example".
 */
export function CardFront({
  face,
  draw = false,
  spin = false,
  className,
}: {
  face: CardFace;
  draw?: boolean;
  /** Печатка повільно обертається після малювання (components/card/seal.tsx). */
  spin?: boolean;
  className?: string;
}) {
  const t = face.tier;
  const dark = t.finish === "black" || t.finish === "red_seal";
  return (
    <div role="img" aria-label={face.summary} className={cn("ncj-face", className)} style={tierVars(t) as CSSProperties}>
      <div className="ncj-window">
        <div className="ncj-rating">
          <div>
            <div className="ncj-num">{face.score}</div>
            <div className="ncj-pos">{face.positionCode}</div>
          </div>
          <div className="ncj-lvl">
            Level<b>{face.level}</b>
            {t.finishName}
          </div>
        </div>
        <div
          className="ncj-art"
          style={{ backgroundImage: `url("${dark ? UNDERPRINT_ON_BLACK : UNDERPRINT_ON_PAPER}")`, backgroundSize: "cover" }}
        >
          {face.sealSeed !== null ? (
            <Seal seed={face.sealSeed} level={t.sealLayers} inks={t.sealInks} strokeWidth={0.85} draw={draw} spin={spin} />
          ) : (
            <p className="ncj-art-empty">The seal is drawn when you create the card.</p>
          )}
        </div>
        <div className="ncj-name">{face.displayName}</div>
        {face.stats.length > 0 ? (
          <div className="ncj-stats">
            {face.stats.map((s) => (
              <div key={s.code} className={s.value === null ? "gap" : undefined}>
                <b>{s.value ?? "gap"}</b>
                <span>{s.code}</span>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {face.marker ? <span className="ncj-tag ncj-tag-marker">{face.marker}</span> : null}
      {face.kind === "example" ? <span className="ncj-tag ncj-tag-example">EXAMPLE</span> : null}
      <div className="ncj-setline">
        <span>SEASON 1</span>
        <span>{face.number ?? "Not issued yet"}</span>
      </div>
    </div>
  );
}
