import type { CSSProperties } from "react";
import { LogoMark } from "@/components/wordmark";
import { tierVars } from "@/lib/card/tiers";
import type { CardFace } from "@/lib/card/view";
import { cn } from "@/lib/utils";
import { SealBadge } from "./seal-badge";

/**
 * Лицьовий бік картки у форматі банківської (напрям «Payday»): знак і номер, кругла
 * печатка-жетон з рівнем праворуч угорі, бал і роль, ім'я тисненням і
 * до трьох джерел з «gap» замість нуля. Позначка «Example card» лише на face.kind === "example".
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
  return (
    <div role="img" aria-label={face.summary} className={cn("ncj-face", className)} style={tierVars(t) as CSSProperties}>
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
        </div>
        <div className="ncj-bot">
          <span className="ncj-name">{face.displayName}</span>
          {face.stats.length > 0 ? (
            <span className="ncj-stats">
              {face.stats.slice(0, 3).map((s) => (
                <span key={s.code} className={s.value === null ? "gap" : undefined}>
                  {s.code}
                  <b>{s.value ?? "gap"}</b>
                </span>
              ))}
            </span>
          ) : null}
        </div>
      </div>
      <SealBadge
        seed={face.sealSeed}
        tier={t}
        value={face.level}
        draw={draw}
        spin={spin}
        className={cn("ncj-face-badge", face.sealSeed === null && "ncj-badge-empty")}
      />
      {face.marker ? <span className="ncj-tag ncj-tag-marker">{face.marker}</span> : null}
      {face.kind === "example" ? <span className="ncj-tag ncj-tag-example">Example card</span> : null}
    </div>
  );
}
