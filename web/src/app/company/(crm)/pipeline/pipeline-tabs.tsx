import Link from "next/link";
import { cn } from "@/lib/utils";

/** Лінія вкладок: поточна з рискою 2 px кольору тексту, як меню CRM. */
export const TAB = "inline-flex min-h-11 items-center border-b-2 text-[0.9375rem] font-semibold transition-colors";
export const TAB_ON = "border-ink text-ink";
export const TAB_OFF = "border-transparent text-ink-muted hover:border-line-strong hover:text-ink";

/** Вкладки воронки: дошка, список, знайомства. `query` зберігає фільтри (вакансія, тег). */
export function PipelineTabs({ current, query }: { current: "board" | "list" | "intros"; query?: string }) {
  const tabs = [
    { key: "board", href: `/company/pipeline${query ? `?${query}` : ""}`, label: "Board" },
    { key: "list", href: `/company/pipeline?view=list${query ? `&${query}` : ""}`, label: "List" },
    { key: "intros", href: "/company/pipeline/intros", label: "Intros" },
  ] as const;
  return (
    <nav aria-label="Pipeline views" className="flex gap-5 border-b border-line">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === current ? "page" : undefined}
          className={cn(TAB, "-mb-px", t.key === current ? TAB_ON : TAB_OFF)}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
