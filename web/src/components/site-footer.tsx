import Link from "next/link";
import { LogoMark } from "@/components/wordmark";

// Раунд 5: Agents прибрано (п.9, лишається за прямим посиланням), Terms і Company terms
// злито в один пункт «Terms» (п.11, /terms з розділами candidates/companies).
const LINKS = [
  { href: "/scoring", label: "How scoring works" },
  { href: "/company", label: "For companies" },
  { href: "/faq", label: "FAQ" },
  { href: "/sources", label: "Sources" },
  { href: "/contact", label: "Contact" },
  { href: "/feedback", label: "Got a job? Tell us" },
  { href: "https://x.com/nextcryptojob", label: "X" },
  { href: "/privacy", label: "Privacy" },
  { href: "/terms", label: "Terms" },
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
      </div>
    </footer>
  );
}
