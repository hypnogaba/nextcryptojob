import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/** Повних обертів цифри за її місцем справа: одиниці 2, десятки 1, старші лише до своєї цифри. */
const CYCLES = [2, 1] as const;

/**
 * Число на табло, яке один раз прокручується до себе, як лічильник. У HTML справжнє число
 * (текст «1,900+» у звичайних span), тож без JS і для читачів екрана воно правильне.
 * Цифри над справжньою малює CSS (::before з content: var(--seq) / "", globals.css .ncj-odo),
 * вони не потрапляють ні в текст сторінки, ні в озвучення. Анімація лише CSS: грає з першого
 * кадру, без JS; RollOnView відкладає її до показу, якщо табло ще за краєм екрана.
 */
export function Odometer({ value, className, style }: { value: string; className?: string; style?: CSSProperties }) {
  const chars = [...value];
  const fromRight = new Map<number, number>();
  let k = 0;
  for (let i = chars.length - 1; i >= 0; i--) if (/[0-9]/.test(chars[i])) fromRight.set(i, k++);
  return (
    <span className={cn("ncj-odo", className)} style={style}>
      {chars.map((c, i) => {
        const place = fromRight.get(i);
        if (place === undefined) return <span key={i}>{c}</span>;
        const rows = Number(c) + 10 * (CYCLES[place] ?? 0);
        if (rows === 0) return <span key={i}>{c}</span>;
        // Рядки над цифрою згори вниз: 0, 1, 2 ... і останній на одну менший за саму цифру.
        const seq = Array.from({ length: rows }, (_, r) => r % 10).join("\\A ");
        return (
          <span key={i} className="ncj-odo-col" style={{ "--rows": rows, "--seq": `"${seq}"` } as CSSProperties}>
            {c}
          </span>
        );
      })}
    </span>
  );
}
