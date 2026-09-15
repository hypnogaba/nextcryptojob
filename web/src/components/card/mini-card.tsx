import { tierFor } from "@/lib/card/tiers";
import { SealBadge } from "./seal-badge";

/**
 * Малий жетон: коло кольору картки, печатка з `level` шарами і число в лимонному ядрі.
 * Для драбини рівнів і рядків дошки. Декоративний: підпис дає батько.
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
  /** Що написати в ядрі: рівень або бал. */
  value: number | string;
  /** Печатка повільно обертається (components/card/seal.tsx). */
  spin?: boolean;
  className?: string;
}) {
  return <SealBadge seed={seed} tier={tierFor(level)} value={value} caption={null} plate spin={spin} className={className} />;
}
