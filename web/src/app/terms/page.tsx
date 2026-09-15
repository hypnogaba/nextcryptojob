import type { Metadata } from "next";
import { LEGAL_DOCS } from "@/lib/legal/docs";
import { renderMarkdown } from "@/lib/legal/markdown";

// Один "Terms" замість двох пунктів у підвалі (власник 15.09, п.11): candidates і companies
// на тій самій сторінці, кожен розділ своїм якорем. Текст із docs/legal не чіпаємо (це
// чернетки для юриста), лише склад сторінки. /terms/companies тепер редирект на #companies.
export const metadata: Metadata = {
  title: "Terms",
  description: "Terms for candidates and for companies that use NextCryptoJob, on one page.",
  alternates: { canonical: "/terms" },
};

const TAB = "inline-flex min-h-10 items-center rounded-full border border-line px-4 text-sm font-medium text-ink hover:bg-soft";

export default function TermsPage() {
  return (
    <article className="mx-auto grid max-w-3xl gap-6 px-4 pt-8 pb-20 text-base leading-relaxed text-ink sm:px-6 sm:pt-14">
      <p className="ncj-label">Terms</p>
      <nav aria-label="Sections" className="flex flex-wrap gap-2">
        <a href="#candidates" className={TAB}>
          For candidates
        </a>
        <a href="#companies" className={TAB}>
          For companies
        </a>
      </nav>
      <section id="candidates" className="grid scroll-mt-6 gap-4">
        {renderMarkdown(LEGAL_DOCS.terms.source)}
      </section>
      <hr className="border-line" />
      <section id="companies" className="grid scroll-mt-6 gap-4">
        {renderMarkdown(LEGAL_DOCS.termsCompanies.source)}
      </section>
    </article>
  );
}
