import Link from "next/link";
import type { ReactNode } from "react";
import { ago } from "@/lib/admin/job-sources";
import { cn } from "@/lib/utils";

/**
 * Дрібні частини головної адмінки (/admin) і налаштувань: блок у рамці дошки скаута
 * (2 px кольору тексту, як таблиці в components/board.tsx), число табло з підписом і
 * «скільки часу минуло». Лише для сторінок, що пройшли currentAdmin().
 */

export const NUM = new Intl.NumberFormat("en-US");
const EXACT = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
export const CLOCK = new Intl.DateTimeFormat("en-US", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "UTC" });

export const LINK =
  "font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand";

/** Час тому з точною датою в підказці; null = «never». */
export function Ago({ at, now, never = "never" }: { at: number | null; now: number; never?: string }) {
  if (at === null) return <span className="text-ink-muted">{never}</span>;
  return (
    <time dateTime={new Date(at).toISOString()} title={`${EXACT.format(at)} UTC`}>
      {ago(at, now)}
    </time>
  );
}

/** Блок головної: заголовок, посилання на докладну сторінку, вміст. */
export function Panel({
  id,
  title,
  links = [],
  children,
  className,
}: {
  id: string;
  title: string;
  links?: { href: string; label: string }[];
  children: ReactNode;
  className?: string;
}) {
  return (
    <section aria-labelledby={`${id}-title`} className={cn("min-w-0 rounded-[10px] border-[1.5px] border-line bg-surface", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b-2 border-ink px-4 py-3">
        <h2 id={`${id}-title`} className="display text-[1.5rem] leading-none">
          {title}
        </h2>
        {links.length > 0 ? (
          <div className="flex flex-wrap gap-x-4 text-sm">
            {links.map((l) => (
              <Link key={l.href} href={l.href} className={cn(LINK, "inline-flex min-h-11 items-center")}>
                {l.label}
              </Link>
            ))}
          </div>
        ) : null}
      </div>
      <div className="grid gap-5 px-4 py-4">{children}</div>
    </section>
  );
}

/** Сітка чисел: 2 колонки на телефоні, більше ширше. */
export function Stats({ children, className }: { children: ReactNode; className?: string }) {
  return <dl className={cn("grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-3", className)}>{children}</dl>;
}

export function Stat({
  label,
  value,
  note,
  alert = false,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  alert?: boolean;
}) {
  return (
    <div className="min-w-0" data-alert={alert ? "" : undefined}>
      <dt className="text-xs font-semibold tracking-[0.02em] text-ink-muted uppercase">{label}</dt>
      <dd
        className={cn(
          "mt-1 font-display text-[1.75rem] leading-none font-black tabular-nums break-words",
          alert ? "text-danger" : "text-ink",
        )}
      >
        {value}
      </dd>
      {note ? <dd className="mt-1 text-xs text-ink-muted">{note}</dd> : null}
    </div>
  );
}

/** Підзаголовок усередині блоку. */
export function SubHead({ children }: { children: ReactNode }) {
  return <h3 className="font-display text-[1.0625rem] leading-none font-extrabold tracking-[0.02em] uppercase">{children}</h3>;
}

/** Частка від цілого для підпису: «42%», без ділення на нуль. */
export function pct(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}
