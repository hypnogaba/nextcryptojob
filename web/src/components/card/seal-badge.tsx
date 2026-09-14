import type { CSSProperties } from "react";
import type { Tier } from "@/lib/card/tiers";
import { cn } from "@/lib/utils";
import { Seal } from "./seal";

/**
 * Кругла печатка-жетон: гільош-розетка з гаманця людини (шарів стільки, скільки рівень)
 * і лимонне ядро з числом. Власник 14.09: бейджі «як у старій версії, з круглою завитушкою».
 * `plate` малює під розеткою коло кольору картки: для жетона на білій сторінці,
 * де світлі лінії чорної картки інакше зникли б. Декоративна: підпис дає батько.
 */
export function SealBadge({
  seed,
  tier,
  value,
  caption = "LVL",
  plate = false,
  draw = false,
  spin = false,
  className,
}: {
  seed: number | null;
  tier: Tier;
  /** Число в ядрі: рівень або бал. */
  value: number | string;
  /** Дрібний підпис над числом або null. */
  caption?: string | null;
  plate?: boolean;
  draw?: boolean;
  spin?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn("ncj-badge", plate && "ncj-badge-plate", className)}
      style={
        plate
          ? ({ "--badge-plate": tier.frame, "--badge-sheen": sheen(tier) } as CSSProperties)
          : undefined
      }
    >
      {seed !== null ? (
        <Seal seed={seed} level={tier.sealLayers} inks={tier.sealInks} strokeWidth={1.1} segments={5} draw={draw} spin={spin} />
      ) : null}
      <span className="ncj-badge-core">
        {caption ? <small>{caption}</small> : null}
        <b>{value}</b>
      </span>
    </span>
  );
}

function sheen(t: Tier): string {
  if (!t.sheen) return "none";
  const [a, b, c, d] = t.sheen;
  return `linear-gradient(135deg, ${a} 0%, ${b} 42%, ${c} 55%, ${d} 100%)`;
}
