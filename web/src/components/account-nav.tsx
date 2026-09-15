import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Кабінет, round4 (макет design-round4/dir-6): бічне меню зі спільним активним станом (чорна
 * смужка зліва на десктопі, підсвітка тла при наведенні) і вміст праворуч. На мобільному
 * бічне меню стає горизонтальним рядком, що гортається (globals.css, .acct-side).
 * Той самий компонент для /account і /settings: активний пункт визначає сторінка.
 */
export type AccountKey = "overview" | "card" | "jobs" | "answers" | "settings" | "company";

const ITEMS: readonly { key: AccountKey; href: string; label: string }[] = [
  { key: "overview", href: "/account", label: "Overview" },
  { key: "card", href: "/profile", label: "Card and score" },
  { key: "jobs", href: "/jobs", label: "Your jobs" },
  { key: "answers", href: "/welcome", label: "Your answers" },
  { key: "settings", href: "/settings", label: "Settings" },
  { key: "company", href: "/company/start", label: "Company account" },
];

export function AccountShell({ active, title, sub, children }: { active: AccountKey; title: string; sub?: string; children: ReactNode }) {
  return (
    <section className="mx-auto max-w-5xl px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-14">
      <h1 className="display text-title">{title}</h1>
      {sub ? <p className="mt-2 text-ink-muted">{sub}</p> : null}
      <div className="acct mt-8">
        <nav aria-label="Your account" className="acct-side">
          {ITEMS.map((item) => (
            <Link key={item.key} href={item.href} aria-current={item.key === active ? "page" : undefined} className="acct-item">
              {item.label}
            </Link>
          ))}
        </nav>
        <div className="acct-content">{children}</div>
      </div>
    </section>
  );
}
