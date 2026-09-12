import type { Metadata } from "next";
import { docTitle, type LegalDoc } from "@/lib/legal/docs";
import { renderMarkdown } from "@/lib/legal/markdown";

export function legalMetadata(doc: LegalDoc): Metadata {
  return { title: docTitle(doc.source), description: doc.description, alternates: { canonical: doc.path } };
}

/** Юридична сторінка з Markdown. Смужка DRAFT з самого документа лишається на місці. */
export function LegalPage({ doc }: { doc: LegalDoc }) {
  return (
    <article className="mx-auto grid max-w-3xl gap-4 px-4 pt-8 pb-20 text-base leading-relaxed text-ink sm:px-6 sm:pt-14">
      {renderMarkdown(doc.source)}
    </article>
  );
}
