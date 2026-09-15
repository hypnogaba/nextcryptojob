import Link from "next/link";
import { LogoMark } from "@/components/wordmark";

const LINKS = [
  { href: "/scoring", label: "How scoring works" },
  { href: "/company", label: "For companies" },
  { href: "/agents", label: "Agents" },
  { href: "/faq", label: "FAQ" },
  { href: "/contact", label: "Contact" },
  { href: "/feedback", label: "Got a job? Tell us" },
  { href: "https://x.com/nextcryptojob", label: "X" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
  { href: "/terms/companies", label: "Company terms" },
] as const;

export function SiteFooter() {
  return (
    <footer className="mx-auto mt-auto w-full max-w-[1280px] px-[clamp(16px,4vw,32px)]">
      <div className="grid gap-4 border-t border-line py-8 sm:py-10">
        <div className="flex flex-wrap items-center justify-between gap-x-8 gap-y-3">
          <p className="inline-flex items-center gap-2 font-display text-[1.0625rem] font-bold tracking-[-0.02em]">
            <LogoMark className="size-6" />
            NextCryptoJob
          </p>
          <nav aria-label="Footer">
            <ul className="-mx-2 flex flex-wrap">
              {LINKS.map((link) => (
                <li key={link.href}>
                  {link.href.startsWith("https://") ? (
                    <a
                      href={link.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex min-h-11 items-center px-2 text-sm text-ink-muted transition-colors hover:text-ink"
                    >
                      {link.label}
                    </a>
                  ) : (
                    <Link
                      href={link.href}
                      className="inline-flex min-h-11 items-center px-2 text-sm text-ink-muted transition-colors hover:text-ink"
                    >
                      {link.label}
                    </Link>
                  )}
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <p className="max-w-[72ch] text-sm text-ink-muted">
          Jobs come from company career pages, public job boards and companies that post here. Your wallets and links
          never go on your card.
        </p>
      </div>
    </footer>
  );
}
