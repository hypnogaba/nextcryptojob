import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { docTitle, LEGAL_DOCS } from "./docs";
import { renderMarkdown } from "./markdown";

const EM_DASH = String.fromCharCode(0x2014);
const docs = Object.values(LEGAL_DOCS);

describe("legal pages", () => {
  it.each(docs.map((d) => [d.path, d] as const))("%s is the current copy of docs/legal", (_path, doc) => {
    const original = readFileSync(new URL(`../../../../docs/legal/${doc.file}`, import.meta.url), "utf8");
    // Та сама правка, що в scripts/legal-content.mjs; розбіжність = забули запустити скрипт.
    expect(doc.source).toBe(original.replace(new RegExp(`\\s*${EM_DASH}\\s*`, "g"), ", "));
  });

  it.each(docs.map((d) => [d.path, d] as const))("%s keeps the DRAFT banner and has no em dash", (_path, doc) => {
    const out = renderToStaticMarkup(<>{renderMarkdown(doc.source)}</>);
    expect(out).toMatch(/<blockquote[^>]*><p><strong[^>]*>DRAFT\. Not in force\./);
    expect(out).not.toContain(EM_DASH);
    // Сутності складені з частин, щоб цей файл не спіткнувся об no-em-dash.test.ts.
    expect(out).not.toMatch(new RegExp(["&", "mdash;|&#", "8212;"].join("")));
    expect(out).toMatch(/^<h1 /);
  });

  it("titles each page by its first heading", () => {
    expect(docs.map((d) => docTitle(d.source))).toEqual([
      "NextCryptoJob Privacy Policy",
      "NextCryptoJob Terms for Candidates",
      "NextCryptoJob Terms for Companies",
      "How Scoring Works",
    ]);
  });
});
