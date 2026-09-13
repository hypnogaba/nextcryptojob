import Link from "next/link";

const LINKS = [
  { href: "/scoring", label: "How scoring works" },
  { href: "/company", label: "For companies" },
  { href: "/agents", label: "Agents" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/terms/companies", label: "Company terms" },
  { href: "/login", label: "Sign in" },
] as const;

export function SiteFooter() {
  return (
    <footer className="mx-auto mt-auto w-full max-w-[1240px] px-[clamp(16px,4vw,56px)]">
      <div className="flex flex-wrap items-end justify-between gap-x-10 gap-y-6 border-t-2 border-ink py-12 sm:py-16">
        <p className="display max-w-[14ch] text-[clamp(2rem,1.2rem+3vw,3.5rem)] leading-[0.9]">Free for job seekers.</p>
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
            Jobs come from company career pages, public job boards and companies that post here. Your wallets and links
            never go on your card.
          </p>
        </div>
      </div>
    </footer>
  );
}
