import type { CSSProperties } from "react";
import { levelFor, tierFor, tierVars } from "@/lib/card/tiers";
import { cn } from "@/lib/utils";

/**
 * Таблиці в голосі дошки скаута (головна, розділ «Scouting board»): рамка 2 px
 * кольору тексту, заголовки колонок вузьким Big Shoulders над лінією 2 px,
 * рядки через тонку лінію, наведення тлом акценту. Таблиця гортається у своїй
 * рамці, тож сторінка на 390 px вбік не їде. Спільне для CRM і адмінки.
 */
// relative: sr-only підписи в клітинках (position: absolute) інакше тікають з рамки
// і розширюють сторінку на телефоні.
export const BOARD = "relative min-w-0 overflow-x-auto rounded-[10px] border-2 border-ink bg-surface";
export const TABLE = "w-full border-collapse text-left text-sm";
export const CAPTION = "px-4 pt-3 text-left text-sm text-ink-muted";
export const TH =
  "border-b-2 border-ink px-4 py-3 align-bottom font-display text-[0.9375rem] font-extrabold tracking-[0.02em] whitespace-nowrap";
export const TR = "border-b border-line last:border-b-0 hover:bg-brand-soft";
export const TD = "px-4 py-3 align-top";
/** Щільніші клітинки для адмінки: більше рядків на екрані. */
export const TH_TIGHT =
  "border-b-2 border-ink px-3 py-2.5 align-bottom font-display text-[0.9375rem] font-extrabold tracking-[0.02em] whitespace-nowrap";
export const TD_TIGHT = "px-3 py-2.5 align-top";
/** Код позиції (ENG, TRD), як у колонці Pos на дошці. */
export const POS = "font-display text-[1.375rem] leading-none font-black";

/**
 * Мала картка з балом: обробка рамки за рівнем і бал числом табло. Декоративна:
 * текст балу дає батько (видимий або sr-only).
 */
export function ScoreChip({ score, level, className }: { score: number; level?: number | null; className?: string }) {
  const tier = tierFor(level ?? levelFor(score));
  return (
    <span aria-hidden="true" data-finish={tier.finish} className={cn("ncj-chip", className)} style={tierVars(tier) as CSSProperties}>
      <b>{score}</b>
    </span>
  );
}
