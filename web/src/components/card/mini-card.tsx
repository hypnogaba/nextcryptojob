import type { CSSProperties } from "react";
import { tierFor, tierVars } from "@/lib/card/tiers";
import { cn } from "@/lib/utils";
import { Seal } from "./seal";

/**
 * Мала картка: обробка рівня, печатка з `level` шарами і число. Для драбини
 * рівнів на головній і для рядків дошки. Декоративна: підпис дає батько.
 */
export function MiniCard({
  level,
  seed,
  value,
  spin = false,
  className,
}: {
  level: number;
  seed: number;
  /** Що написати в куті: рівень або бал. */
  value: number | string;
  /** Печатка повільно обертається (components/card/seal.tsx). */
  spin?: boolean;
  className?: string;
}) {
  const tier = tierFor(level);
  return (
    <div aria-hidden="true" className={cn("ncj-mini", className)} style={tierVars(tier) as CSSProperties}>
      <div className="ncj-mini-window">
        <Seal seed={seed} level={tier.sealLayers} inks={tier.sealInks} strokeWidth={1.6} segments={4} spin={spin} className="ncj-mini-seal" />
      </div>
      <b>{value}</b>
    </div>
  );
}
