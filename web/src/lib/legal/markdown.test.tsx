import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { parseMarkdown, renderMarkdown, safeHref } from "./markdown";

const html = (md: string) => renderToStaticMarkup(<>{renderMarkdown(md)}</>);

describe("parseMarkdown", () => {
  it("reads headings with unique anchors, paragraphs joined across lines and rules", () => {
    expect(parseMarkdown("# Title\n\nOne line\nnext line.\n\n---\n\n## 1. Summary\n\n## 1. Summary")).toEqual([
      { kind: "heading", level: 1, text: "Title", id: "title" },
      { kind: "paragraph", text: "One line next line." },
      { kind: "rule" },
      { kind: "heading", level: 2, text: "1. Summary", id: "1-summary" },
      { kind: "heading", level: 2, text: "1. Summary", id: "1-summary-1" },
    ]);
  });

  it("nests an indented list under its item and keeps ordered numbering", () => {
    expect(parseMarkdown("- a\n  - a1\n  - a2\n- b\n\n3. x\n4. y")).toEqual([
      {
        kind: "list",
        ordered: false,
        start: 1,
        items: [
          {
            text: "a",
            children: [
              { kind: "list", ordered: false, start: 1, items: [{ text: "a1", children: [] }, { text: "a2", children: [] }] },
            ],
          },
          { text: "b", children: [] },
        ],
      },
      { kind: "list", ordered: true, start: 3, items: [{ text: "x", children: [] }, { text: "y", children: [] }] },
    ]);
  });

  it("reads tables and block quotes", () => {
    expect(parseMarkdown("> **DRAFT.**\n> Second\n\n| A | B |\n|---|---|\n| 1 | 2 |")).toEqual([
      { kind: "quote", children: [{ kind: "paragraph", text: "**DRAFT.** Second" }] },
      { kind: "table", head: ["A", "B"], rows: [["1", "2"]] },
    ]);
  });
});

describe("renderMarkdown", () => {
  it("renders links, autolinks, bold and code, and keeps placeholders as text", () => {
    const out = html("See [How scoring works](https://nextcryptojob.xyz/how-scoring-works), <https://gdpr-info.eu/art-7-gdpr/>, **bold**, `code` and [LEGAL NAME].");
    expect(out).toContain('<a href="/how-scoring-works"');
    expect(out).toContain('href="https://gdpr-info.eu/art-7-gdpr/" class=');
    expect(out).toContain('rel="noreferrer"');
    expect(out).toContain("<strong");
    expect(out).toContain("<code");
    expect(out).toContain("[LEGAL NAME]");
  });

  it("never turns HTML or unsafe links into markup", () => {
    const out = html('<script>alert(1)</script> [x](javascript:alert(1)) <img src=x onerror="y">');
    expect(out).not.toContain("<script");
    expect(out).not.toContain("<img");
    expect(out).not.toContain('href="javascript');
    expect(out).toContain("&lt;script&gt;");
  });

  it("wraps tables so they scroll on a phone instead of the page", () => {
    expect(html("| A |\n|---|\n| 1 |")).toMatch(/^<div class="overflow-x-auto[^"]*"><table/);
  });
});

describe("safeHref", () => {
  it.each([
    ["https://example.com/a", "https://example.com/a"],
    ["https://nextcryptojob.xyz", "/"],
    ["https://nextcryptojob.xyz/privacy#companies", "/privacy#companies"],
    ["mailto:hi@example.com", "mailto:hi@example.com"],
    ["/terms", "/terms"],
    ["#top", "#top"],
    ["//evil.example", null],
    ["javascript:alert(1)", null],
    ["data:text/html,x", null],
  ])("%s -> %s", (input, expected) => {
    expect(safeHref(input)).toBe(expected);
  });
});
