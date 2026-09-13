import Link from "next/link";
import { cn } from "@/lib/utils";

/** Вкладки воронки: дошка, список, знайомства. `query` зберігає фільтри (вакансія, тег). */
export function PipelineTabs({ current, query }: { current: "board" | "list" | "intros"; query?: string }) {
  const tabs = [
    { key: "board", href: `/company/pipeline${query ? `?${query}` : ""}`, label: "Board" },
    { key: "list", href: `/company/pipeline?view=list${query ? `&${query}` : ""}`, label: "List" },
    { key: "intros", href: "/company/pipeline/intros", label: "Intros" },
  ] as const;
  return (
    <nav aria-label="Pipeline views" className="flex gap-1">
      {tabs.map((t) => (
        <Link
          key={t.key}
          href={t.href}
          aria-current={t.key === current ? "page" : undefined}
          className={cn(
            "inline-flex min-h-11 items-center rounded-md border px-3 text-sm font-medium",
            t.key === current ? "border-brand bg-brand-soft text-ink" : "border-line bg-surface text-ink-muted hover:bg-wash hover:text-ink",
          )}
        >
          {t.label}
        </Link>
      ))}
    </nav>
  );
}
