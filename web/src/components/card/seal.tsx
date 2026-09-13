import type { CSSProperties } from "react";
import { makeSeal, petalAngle, petalPath, SEAL_BOX, type SealDensity } from "@/lib/card/seal";
import { cn } from "@/lib/utils";

/**
 * Печатка картки як SVG. Кожен шар = одна пелюстка в <defs> і її повороти <use>:
 * у кілька разів менше розмітки, ніж повна крива. Штрих, пунктир і зсув задає
 * група шару, екземпляри <use> їх успадковують, тож анімація малювання (globals.css,
 * .ncj-seal-draw) іде по всіх пелюстках шару разом, шар за шаром.
 * Без хуків: працює і на сервері, і в клієнті.
 */
export function Seal({
  seed,
  level,
  inks,
  strokeWidth = 0.8,
  segments = 6,
  density = "page",
  draw = false,
  className,
}: {
  seed: number;
  level: number;
  inks: readonly [string, string];
  /** Товщина лінії в одиницях viewBox (200 на ширину). */
  strokeWidth?: number;
  /** Відрізків Безьє на пелюстку: менше для дрібних печаток. */
  segments?: number;
  density?: SealDensity;
  /** Малювати себе при показі (один раз; статично під prefers-reduced-motion). */
  draw?: boolean;
  className?: string;
}) {
  const layers = makeSeal(seed, level, density);
  // Однакові seed, щільність і точність дають однакову геометрію, тож збіг id безпечний.
  const id = `ncjs-${seed.toString(36)}-${density[0]}${segments}`;
  return (
    <svg
      viewBox={`-${SEAL_BOX} -${SEAL_BOX} ${2 * SEAL_BOX} ${2 * SEAL_BOX}`}
      className={cn("ncj-seal", draw && "ncj-seal-draw", className)}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {layers.map((l, i) => (
          <path key={i} id={`${id}-${i}`} d={petalPath(l, segments)} pathLength={1} />
        ))}
      </defs>
      {layers.map((l, i) => (
        <g
          key={i}
          className="ncj-layer"
          fill="none"
          stroke={inks[i % 2]}
          strokeWidth={strokeWidth}
          strokeLinejoin="round"
          style={{ "--i": i } as CSSProperties}
        >
          {Array.from({ length: l.petals }, (_, k) => (
            <use key={k} href={`#${id}-${i}`} transform={k ? `rotate(${petalAngle(l, k)})` : undefined} />
          ))}
        </g>
      ))}
    </svg>
  );
}
