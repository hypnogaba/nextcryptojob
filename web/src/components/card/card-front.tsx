import type { CSSProperties } from "react";
import { LogoMark } from "@/components/wordmark";
import { nameFontScale } from "@/lib/card/display-name";
import { MAX_LEVEL, tierVars } from "@/lib/card/tiers";
import type { CardFace } from "@/lib/card/view";
import { cn } from "@/lib/utils";
import { Seal } from "./seal";

/**
 * Лицьовий бік картки у форматі банківської (round4, макет dir-6): знак і номер, бал і роль,
 * гільош-печатка прикрасою поруч з балом (без числа всередині), підпис Name / Level n of 10 /
 * Finish трьома колонками. Джерела бала на лицьовому боці більше немає (лише на звороті).
 * Позначка «Example card» лише на face.kind === "example", і лише коли hideTag не задано (на
 * головній її замінює підпис під стосом карток).
 */
export function CardFront({
  face,
  draw = false,
  spin = false,
  /** Світлова смуга по картці (лише жива картка на головній). */
  sweep = false,
  /** Не показувати позначку «Example card»: на головній її замінює підпис під стосом. */
  hideTag = false,
  className,
}: {
  face: CardFace;
  draw?: boolean;
  /** Печатка повільно обертається після малювання (components/card/seal.tsx). */
  spin?: boolean;
  sweep?: boolean;
  hideTag?: boolean;
  className?: string;
}) {
  const t = face.tier;
  return (
    <div
      role="img"
      aria-label={face.summary}
      className={cn("ncj-face", sweep && "ncj-sweep", className)}
      style={{ ...(tierVars(t) as CSSProperties), "--sweep-op": t.finish === "black" ? 0.14 : 0.55 } as CSSProperties}
    >
      <div className="ncj-window">
        <div className="ncj-top">
          <span className="ncj-brand">
            <LogoMark className="ncj-brand-mark" />
            NextCryptoJob
          </span>
          <span className="ncj-set">
            Season 1 · {face.number ?? "not issued yet"}
          </span>
        </div>
        <div className="ncj-mid">
          <span className="ncj-num">{face.score}</span>
          <span className="ncj-of">
            of 100<b>{face.roleName}</b>
          </span>
          {face.sealSeed !== null ? (
            <Seal seed={face.sealSeed} level={t.sealLayers} inks={t.sealInks} strokeWidth={1.1} segments={6} draw={draw} spin={spin} className="ncj-mid-seal" />
          ) : (
            <span aria-hidden="true" className="ncj-mid-seal-empty" />
          )}
        </div>
        <div className="ncj-bot">
          <div className="ncj-bot-col ncj-name" style={{ "--name-scale": nameFontScale(face.displayName) } as CSSProperties}>
            <span>Name</span>
            <b>{face.displayName}</b>
          </div>
          <div className="ncj-bot-col">
            <span>Level</span>
            <b>
              {face.level} of {MAX_LEVEL}
            </b>
          </div>
          <div className="ncj-bot-col">
            <span>Finish</span>
            <b>{t.finishName}</b>
          </div>
        </div>
      </div>
      {face.marker ? <span className="ncj-tag ncj-tag-marker">{face.marker}</span> : null}
      {face.kind === "example" && !hideTag ? <span className="ncj-tag ncj-tag-example">Example card</span> : null}
    </div>
  );
}
