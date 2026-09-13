import Link from "next/link";

const LINKS = [
  { href: "/how-scoring-works", label: "How scoring works" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/terms/companies", label: "Company terms" },
  { href: "/company", label: "For companies" },
  { href: "/login", label: "Sign in" },
] as const;

export function SiteFooter() {
  return (
    <footer className="mx-auto mt-auto w-full max-w-[1240px] px-[clamp(16px,4vw,56px)]">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6 border-t-2 border-ink py-12 sm:py-16">
        <p className="display max-w-[14ch] text-[clamp(2rem,1.2rem+3vw,3.5rem)] leading-[0.9]">Your work is the card.</p>
        <div className="grid gap-3">
          <nav aria-label="Footer">
            <ul className="-mx-2 flex flex-wrap">
              {LINKS.map((link) => (
                <li key={link.href}>
                  <Link
                    href={link.href}
                    className="inline-flex min-h-11 items-center px-2 text-[0.9375rem] text-ink-muted transition-colors hover:text-ink"
                  >
                    {link.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <p className="text-sm text-ink-muted">
            Scored from public work. Your wallets and links never go on the card.
          </p>
        </div>
      </div>
    </footer>
  );
}
