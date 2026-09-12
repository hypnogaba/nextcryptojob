import type { ReactNode } from "react";

/**
 * Малий рендер Markdown для юридичних сторінок, без залежностей і без
 * dangerouslySetInnerHTML: лише те, що є в docs/legal (заголовки, абзаци,
 * цитати, списки з вкладеністю, таблиці, лінія, **жирний**, `код`,
 * [посилання](url) і <https://автопосилання>). HTML у тексті лишається текстом.
 */

export type Block =
  | { kind: "heading"; level: number; text: string; id: string }
  | { kind: "paragraph"; text: string }
  | { kind: "quote"; children: Block[] }
  | { kind: "list"; ordered: boolean; start: number; items: ListItem[] }
  | { kind: "table"; head: string[]; rows: string[][] }
  | { kind: "rule" };

export type ListItem = { text: string; children: Block[] };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const LIST_ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)*\|?\s*$/;

const indentOf = (line: string) => line.length - line.trimStart().length;
const isOrdered = (marker: string) => /\d/.test(marker);

function startsBlock(lines: string[], i: number): boolean {
  const line = lines[i];
  return (
    HEADING.test(line) ||
    RULE.test(line) ||
    QUOTE.test(line) ||
    LIST_ITEM.test(line) ||
    (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]))
  );
}

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}

/** Список з позиції start; повертає блок і перший рядок після нього. */
function parseList(lines: string[], start: number): [Block, number] {
  const first = LIST_ITEM.exec(lines[start])!;
  const indent = first[1].length;
  const ordered = isOrdered(first[2]);
  const items: ListItem[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      // Порожній рядок не рве список, якщо далі пункт того самого рівня.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      const next = j < lines.length ? LIST_ITEM.exec(lines[j]) : null;
      if (next && next[1].length === indent && isOrdered(next[2]) === ordered) {
        i = j;
        continue;
      }
      break;
    }
    const m = LIST_ITEM.exec(line);
    if (m && m[1].length === indent) {
      if (isOrdered(m[2]) !== ordered) break;
      items.push({ text: m[3].trim(), children: [] });
      i++;
      continue;
    }
    const last = items.at(-1);
    if (!last || (m && m[1].length < indent)) break;
    if (indentOf(line) > indent) {
      if (m) {
        const [child, next] = parseList(lines, i);
        last.children.push(child);
        i = next;
      } else {
        last.text += ` ${line.trim()}`;
        i++;
      }
      continue;
    }
    if (startsBlock(lines, i)) break;
    // Продовження пункту без відступу (як у CommonMark).
    last.text += ` ${line.trim()}`;
    i++;
  }
  return [{ kind: "list", ordered, start: ordered ? parseInt(first[2], 10) : 1, items }, i];
}

function slugify(text: string): string {
  return plainText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .trim()
    .replace(/\s+/g, "-");
}

function parseBlocks(lines: string[], slugs: Map<string, number>): Block[] {
  const out: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") {
      i++;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      const base = slugify(heading[2]) || "section";
      const seen = slugs.get(base) ?? 0;
      slugs.set(base, seen + 1);
      out.push({ kind: "heading", level: heading[1].length, text: heading[2], id: seen ? `${base}-${seen}` : base });
      i++;
      continue;
    }
    if (RULE.test(line)) {
      out.push({ kind: "rule" });
      i++;
      continue;
    }
    if (QUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length && QUOTE.test(lines[i])) inner.push(QUOTE.exec(lines[i++])![1]);
      out.push({ kind: "quote", children: parseBlocks(inner, slugs) });
      continue;
    }
    if (TABLE_ROW.test(line) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = cells(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && TABLE_ROW.test(lines[i])) rows.push(cells(lines[i++]));
      out.push({ kind: "table", head, rows });
      continue;
    }
    if (LIST_ITEM.test(line)) {
      const [list, next] = parseList(lines, i);
      out.push(list);
      i = next;
      continue;
    }
    const para = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() !== "" && !startsBlock(lines, i)) para.push(lines[i++].trim());
    out.push({ kind: "paragraph", text: para.join(" ") });
  }
  return out;
}

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/g, "\n").split("\n"), new Map());
}

// --- Рядкова розмітка ---------------------------------------------------------

const INLINE = /<(https?:\/\/[^\s<>]+)>|\[([^\]]+)\]\(([^()\s]+)\)|\*\*(.+?)\*\*|`([^`]+)`/g;

const SITE = /^https:\/\/(?:www\.)?nextcryptojob\.xyz(?=\/|$)/;

/**
 * Адреса посилання або null. Лише http(s), mailto, шлях на сайті й якір:
 * javascript: і подібне лишається текстом. Посилання на наш домен стають
 * відносними, щоб працювали й на workers.dev.
 */
export function safeHref(raw: string): string | null {
  const url = raw.trim();
  if (SITE.test(url)) return url.replace(SITE, "") || "/";
  if (/^https?:\/\/[^\s]+$/i.test(url) || /^mailto:[^\s]+$/i.test(url)) return url;
  if (/^\/(?!\/)/.test(url) || url.startsWith("#")) return url;
  return null;
}

/** Текст без розмітки (для якорів і заголовка сторінки). */
export function plainText(text: string): string {
  return text.replace(INLINE, (_all, auto, label, _href, bold, code) => auto ?? label ?? bold ?? code ?? "");
}

const LINK = "font-medium text-brand underline underline-offset-4 break-words";

function Anchor({ href, children }: { href: string; children: ReactNode }) {
  const external = /^https?:/i.test(href);
  return (
    <a href={href} className={LINK} {...(external ? { rel: "noreferrer" } : {})}>
      {children}
    </a>
  );
}

export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let k = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const [whole, auto, label, href, bold, code] = m;
    if (auto) {
      const safe = safeHref(auto);
      out.push(safe ? <Anchor key={k++} href={safe}>{auto}</Anchor> : whole);
    } else if (label !== undefined) {
      const safe = safeHref(href);
      out.push(safe ? <Anchor key={k++} href={safe}>{renderInline(label)}</Anchor> : <span key={k++}>{renderInline(label)}</span>);
    } else if (bold !== undefined) {
      out.push(<strong key={k++} className="font-semibold text-ink">{renderInline(bold)}</strong>);
    } else if (code !== undefined) {
      out.push(<code key={k++} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.9em]">{code}</code>);
    }
    last = at + whole.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// --- Блоки --------------------------------------------------------------------

const HEADING_CLASS: Record<number, string> = {
  1: "text-3xl font-semibold tracking-tight sm:text-4xl",
  2: "mt-6 scroll-mt-6 text-xl font-semibold tracking-tight sm:text-2xl",
  3: "mt-3 scroll-mt-6 text-lg font-semibold tracking-tight",
};

function renderBlock(block: Block, key: number): ReactNode {
  switch (block.kind) {
    case "heading": {
      const level = Math.min(block.level, 4) as 1 | 2 | 3 | 4;
      const Tag = `h${level}` as const;
      return (
        <Tag key={key} id={block.id} className={HEADING_CLASS[level] ?? "mt-2 text-base font-semibold"}>
          {renderInline(block.text)}
        </Tag>
      );
    }
    case "paragraph":
      return <p key={key}>{renderInline(block.text)}</p>;
    case "quote":
      return (
        <blockquote key={key} className="grid gap-2 rounded-r-lg border-l-4 border-brand bg-brand-soft px-4 py-3 text-ink">
          {block.children.map(renderBlock)}
        </blockquote>
      );
    case "list": {
      const items = block.items.map((item, i) => (
        <li key={i} className="pl-1">
          {renderInline(item.text)}
          {item.children.length > 0 ? <div className="mt-2 grid gap-2">{item.children.map(renderBlock)}</div> : null}
        </li>
      ));
      return block.ordered ? (
        <ol key={key} start={block.start === 1 ? undefined : block.start} className="grid list-decimal gap-2 pl-6">
          {items}
        </ol>
      ) : (
        <ul key={key} className="grid list-disc gap-2 pl-6">
          {items}
        </ul>
      );
    }
    case "table":
      return (
        <div key={key} className="overflow-x-auto rounded-lg border border-line">
          <table className="w-full border-collapse text-left text-sm">
            <thead className="bg-muted">
              <tr>
                {block.head.map((cell, i) => (
                  <th key={i} scope="col" className="px-3 py-2 align-top font-semibold text-ink">
                    {renderInline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r} className="border-t border-line">
                  {row.map((cell, i) => (
                    <td key={i} className="min-w-32 px-3 py-2 align-top">
                      {renderInline(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "rule":
      return <hr key={key} className="my-2 border-line" />;
  }
}

export function renderMarkdown(source: string): ReactNode {
  return parseMarkdown(source).map(renderBlock);
}
