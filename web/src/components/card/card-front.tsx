import type { CSSProperties } from "react";
import { LogoMark } from "@/components/wordmark";
import { nameFitsOneLine, nameFontScale } from "@/lib/card/display-name";
import { MAX_LEVEL, tierVars } from "@/lib/card/tiers";
import type { CardFace } from "@/lib/card/view";
import { cn } from "@/lib/utils";
import { Seal } from "./seal";

/**
 * Лицьовий бік картки: КРУГЛА ПЕЧАТКА на квадратному аркуші (напрям D, вибір власника 16.09).
 * Банківський формат 1.586 прибрано: люди казали, що картка схожа на платіжну й вводить в оману.
 * Квадрат ще й найкраще стоїть у стрічці X.
 *
 * Будова: знак і рядок сезону вгорі; печатка на весь аркуш, а бал у ЧИСТОМУ крузі посередині
 * (лінії печатки не йдуть по цифрах: круг непрозорий і лежить поверх); унизу нік і рівень.
 * Шари печатки повільно обертаються (spin), сусідні в різні боки, і малюються один за одним
 * при появі (draw). Позначка «Example card» лише на face.kind === "example" і лише без hideTag.
 */
export function CardFront({
  face,
  draw = false,
  spin = false,
  /** Світлова смуга по аркушу (лише жива картка на головній). */
  sweep = false,
  /** Не показувати позначку «Example card»: на головній її замінює підпис під карткою. */
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
          <span className="ncj-set">Season 1 · {t.finishName}</span>
        </div>

        <div className="ncj-medal">
          {face.sealSeed !== null ? (
            <Seal
              seed={face.sealSeed}
              level={t.sealLayers}
              inks={t.sealInks}
              strokeWidth={0.9}
              segments={8}
              draw={draw}
              spin={spin}
              className="ncj-medal-seal"
            />
          ) : (
            <span aria-hidden="true" className="ncj-medal-seal-empty" />
          )}
          <span aria-hidden="true" className="ncj-medal-ring" />
          <div className="ncj-medal-core">
            <span className="ncj-num">{face.score}</span>
            <span className="ncj-of">of 100</span>
            <b className="ncj-role">{face.roleName}</b>
            <span className="ncj-lvl">
              Level {face.level} of {MAX_LEVEL}
            </span>
          </div>
        </div>

        <div className="ncj-bot">
          <div
            className="ncj-bot-col ncj-name"
            style={
              {
                "--name-scale": nameFontScale(face.displayName),
                "--name-wrap": nameFitsOneLine(face.displayName) ? "nowrap" : "normal",
              } as CSSProperties
            }
          >
            <span>Name</span>
            <b>{face.displayName}</b>
          </div>
          <div className="ncj-bot-col ncj-bot-right">
            <span>{face.number ?? "not issued yet"}</span>
            <span>nextcryptojob.xyz</span>
          </div>
        </div>
      </div>
      {face.marker ? <span className="ncj-tag ncj-tag-marker">{face.marker}</span> : null}
      {face.kind === "example" && !hideTag ? <span className="ncj-tag ncj-tag-example">Example card</span> : null}
    </div>
  );
}
