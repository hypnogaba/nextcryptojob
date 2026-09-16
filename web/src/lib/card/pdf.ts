// PDF профілю-доказу (docs/specs/2026-09-16-proof-profile-design.md, розділ 3). pdf-lib працює у
// Worker без браузера. Шрифти ті самі TTF-підмножини, що й у картинок картки (lib/card/fonts):
// символ, якого немає в основному шрифті, береться з кириличного; якого немає ніде (емодзі), пропускаємо.
import fontkit from "@pdf-lib/fontkit";
import { PDFDocument, type PDFFont, type PDFPage, PDFName, PDFString, rgb } from "pdf-lib";
import qrcode from "qrcode-generator";
import type { CardBack } from "./back";
import displayB64 from "./fonts/funnel-display-700";
import sansB64 from "./fonts/funnel-sans-500";
import cyrB64 from "./fonts/ncj-cyrillic-600";
import type { ProfileView } from "./profile";

export type PdfCard = {
  displayName: string;
  roleName: string;
  score: number;
  level: number;
  formulaVersion: string;
  issuedOn: string;
  back: CardBack | null;
};

const A4: [number, number] = [595.28, 841.89];
const M = 48;
const INK = rgb(0x0e / 255, 0x0f / 255, 0x12 / 255);
const MUTED = rgb(0x5d / 255, 0x61 / 255, 0x6b / 255);
const LINE = rgb(0.85, 0.86, 0.88);

function bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

type Fonts = { sans: PDFFont; display: PDFFont; cyr: PDFFont; sets: Map<PDFFont, Set<number>> };

/** Відрізки тексту зі шрифтом, що має кожен символ. */
function runs(text: string, primary: PDFFont, f: Fonts): { font: PDFFont; text: string }[] {
  const out: { font: PDFFont; text: string }[] = [];
  for (const ch of text) {
    const cp = ch.codePointAt(0)!;
    let font = primary;
    let c = ch;
    if (!f.sets.get(primary)!.has(cp)) {
      if (f.sets.get(f.cyr)!.has(cp)) font = f.cyr;
      else if (f.sets.get(f.sans)!.has(cp)) font = f.sans;
      else if (/\s/.test(ch)) c = " ";
      else continue;
    }
    const last = out[out.length - 1];
    if (last && last.font === font) last.text += c;
    else out.push({ font, text: c });
  }
  return out;
}

class Writer {
  page: PDFPage;
  y: number;
  constructor(
    private readonly doc: PDFDocument,
    readonly f: Fonts,
  ) {
    this.page = doc.addPage(A4);
    this.y = A4[1] - M;
  }

  get width(): number {
    return A4[0] - 2 * M;
  }

  private ensure(h: number) {
    if (this.y - h < M) {
      this.page = this.doc.addPage(A4);
      this.y = A4[1] - M;
    }
  }

  measure(text: string, size: number, font: PDFFont): number {
    return runs(text, font, this.f).reduce((w, r) => w + r.font.widthOfTextAtSize(r.text, size), 0);
  }

  private drawAt(text: string, x: number, y: number, size: number, font: PDFFont, color = INK): number {
    let cx = x;
    for (const r of runs(text, font, this.f)) {
      this.page.drawText(r.text, { x: cx, y, size, font: r.font, color });
      cx += r.font.widthOfTextAtSize(r.text, size);
    }
    return cx - x;
  }

  /** Абзац з переносом слів; довге слово (адреса) ріжеться по символах. */
  text(text: string, opts: { size?: number; font?: PDFFont; color?: ReturnType<typeof rgb>; url?: string; indent?: number; right?: number; gap?: number; bullet?: boolean } = {}) {
    const size = opts.size ?? 10.5;
    const font = opts.font ?? this.f.sans;
    const x = M + (opts.indent ?? 0);
    const max = this.width - (opts.indent ?? 0) - (opts.right ?? 0);
    const lh = size * 1.4;
    for (const para of text.split(/\n+/)) {
      const lines: string[] = [];
      let cur = "";
      for (const word of para.split(/\s+/).filter(Boolean)) {
        const next = cur ? `${cur} ${word}` : word;
        if (this.measure(next, size, font) <= max) {
          cur = next;
          continue;
        }
        if (cur) lines.push(cur);
        cur = "";
        let piece = "";
        for (const ch of word) {
          if (this.measure(piece + ch, size, font) > max && piece) {
            lines.push(piece);
            piece = "";
          }
          piece += ch;
        }
        cur = piece;
      }
      if (cur) lines.push(cur);
      for (const [i, line] of lines.entries()) {
        this.ensure(lh);
        this.y -= lh;
        // Маркер кружечком: у підмножинах шрифтів немає «•».
        if (opts.bullet && i === 0) this.page.drawCircle({ x: x - 7, y: this.y + size * 0.3 + size * 0.33, size: 1.4, color: MUTED });
        const w = this.drawAt(line, x, this.y + size * 0.3, size, font, opts.color);
        if (opts.url) this.link(x, this.y, w, lh, opts.url);
      }
    }
    this.y -= opts.gap ?? 0;
  }

  heading(text: string) {
    this.ensure(40);
    this.y -= 14;
    this.page.drawLine({ start: { x: M, y: this.y }, end: { x: A4[0] - M, y: this.y }, thickness: 0.6, color: LINE });
    this.y -= 4;
    this.text(text.toUpperCase(), { size: 8.5, font: this.f.display, color: MUTED, gap: 2 });
  }

  link(x: number, y: number, w: number, h: number, url: string) {
    const annot = this.doc.context.obj({
      Type: "Annot",
      Subtype: "Link",
      Rect: [x, y, x + w, y + h],
      Border: [0, 0, 0],
      A: { Type: "Action", S: "URI", URI: PDFString.of(url) },
    });
    const ref = this.doc.context.register(annot);
    const annots = this.page.node.lookup(PDFName.of("Annots"));
    if (annots) (annots as unknown as { push(v: unknown): void }).push(ref);
    else this.page.node.set(PDFName.of("Annots"), this.doc.context.obj([ref]));
  }

  qr(url: string, x: number, top: number, size: number) {
    const q = qrcode(0, "M");
    q.addData(url);
    q.make();
    const n = q.getModuleCount();
    const cell = size / n;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (q.isDark(r, c)) {
          this.page.drawRectangle({ x: x + c * cell, y: top - (r + 1) * cell, width: cell + 0.05, height: cell + 0.05, color: INK });
        }
      }
    }
    this.link(x, top - size, size, size, url);
  }
}

const NO_LIGA = { liga: false, clig: false, dlig: false, calt: false };

const pts = (n: number) => (Math.round(n * 10) / 10).toFixed(1);

export async function renderProfilePdf(card: PdfCard, view: ProfileView, verifyUrl: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  doc.setTitle(`${card.displayName}: ${card.roleName}, score ${card.score}`);
  doc.setCreator("NextCryptoJob");
  doc.setProducer("NextCryptoJob");
  const [sans, display, cyr] = await Promise.all([
    // Без лігатур: інакше «fi» стає одним гліфом, а ширина рахується по двох, і з'являється проміжок.
    doc.embedFont(bytes(sansB64), { features: NO_LIGA }),
    doc.embedFont(bytes(displayB64), { features: NO_LIGA }),
    doc.embedFont(bytes(cyrB64), { features: NO_LIGA }),
  ]);
  const sets = new Map<PDFFont, Set<number>>([
    [sans, new Set(sans.getCharacterSet())],
    [display, new Set(display.getCharacterSet())],
    [cyr, new Set(cyr.getCharacterSet())],
  ]);
  const w = new Writer(doc, { sans, display, cyr, sets });

  // Шапка: ліворуч текст, праворуч QR на перевірку.
  const QR = 84;
  const top = w.y;
  w.qr(verifyUrl, A4[0] - M - QR, top, QR);
  const right = QR + 16;
  w.text(card.displayName, { size: 22, font: display, right });
  w.text(`${card.roleName} · score ${card.score} of 100 · level ${card.level} of 10`, { size: 12, right, gap: 2 });
  const meta = [view.roles.join(", "), view.place].filter(Boolean).join(" · ");
  if (meta) w.text(meta, { color: MUTED, right });
  if (view.contact.telegram) w.text(`Telegram: ${view.contact.telegram.label}`, { url: view.contact.telegram.url, right });
  if (view.contact.email) w.text(`Email: ${view.contact.email}`, { url: `mailto:${view.contact.email}`, right });
  w.y = Math.min(w.y, top - QR) - 6;

  if (card.back) {
    w.heading("How the score is built");
    for (const l of card.back.lines) {
      const value = l.value === null ? "no data" : `${pts(l.points)} pts`;
      const weight = l.kind === "core" ? `weight ${l.weight}` : `bonus up to ${l.weight}`;
      w.text(`${l.name}: ${value} (${weight})`, { indent: 8 });
    }
  }

  for (const g of view.groups) {
    w.heading(g.title);
    if (g.link) w.text(g.link.label, { url: g.link.url, indent: 8 });
    for (const l of g.lines) w.text(l.text, { indent: 16, bullet: true });
  }

  if (view.wallets.length) {
    w.heading("Wallets");
    for (const a of view.wallets) w.text(a, { size: 9, indent: 8 });
  }

  for (const item of view.words) {
    w.heading(item.label);
    w.text(item.text, { indent: 8 });
  }

  if (view.links.length) {
    w.heading("Links added by the owner");
    for (const l of view.links) w.text(`${l.label}: ${l.url}`, { url: l.url, indent: 8 });
  }

  w.y -= 12;
  w.text(`Score formula ${card.formulaVersion}, issued ${card.issuedOn}. Verify: ${verifyUrl}`, {
    size: 8.5,
    color: MUTED,
    url: verifyUrl,
  });

  return doc.save();
}
