import Link from "next/link";
import { HeaderAuthLink } from "@/components/header-auth-link";
import { Wordmark } from "@/components/wordmark";

const NAV = [
  { href: "/#positions", label: "Positions" },
  { href: "/company", label: "For companies" },
  { href: "/#agents", label: "Agents" },
] as const;

export function SiteHeader() {
  return (
    <header className="border-b border-line">
      <div className="mx-auto flex min-h-16 max-w-[1240px] items-center justify-between gap-4 px-[clamp(16px,4vw,56px)]">
        <Wordmark />
        <nav aria-label="Main" className="flex items-center gap-1 sm:gap-3">
          {NAV.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="hidden min-h-11 items-center px-2 text-[0.9375rem] text-ink-muted transition-colors hover:text-ink md:inline-flex"
            >
              {item.label}
            </Link>
          ))}
          <HeaderAuthLink />
        </nav>
      </div>
    </header>
  );
}
