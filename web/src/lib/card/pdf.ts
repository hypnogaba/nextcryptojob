// PDF профілю-доказу (docs/specs/2026-09-16-proof-profile-design.md, розділ 3). pdf-lib працює у
// Worker без браузера. Вигляд односторінки замість CV (власник 16.09, p3): шапка з печаткою рівня,
// ліворуч слова людини й докази, праворуч розбір балу смужками, посилання й QR на перевірку. Шрифти ті самі TTF-підмножини, що й у картинок картки (lib/card/fonts):
// символ, якого немає в основному шрифті, береться з кириличного; якого немає ніде (емодзі), пропускаємо.
import fontkit from "@pdf-lib/fontkit";
import { type Color, PDFDocument, type PDFFont, type PDFPage, PDFName, PDFString, rgb } from "pdf-lib";
import qrcode from "qrcode-generator";
import type { CardBack } from "./back";
import displayB64 from "./fonts/funnel-display-700";
import sansB64 from "./fonts/funnel-sans-500";
import cyrB64 from "./fonts/ncj-cyrillic-600";
import type { ProfileView } from "./profile";
import { tierFor } from "./tiers";

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
const M = 44;
const GUTTER = 22;
/** Права панель: розбір балу, посилання, перевірка. */
const SIDE_W = 186;
const INK = rgb(0x0e / 255, 0x0f / 255, 0x12 / 255);
const MUTED = rgb(0x5d / 255, 0x61 / 255, 0x6b / 255);
const LINE = rgb(0xe8 / 255, 0xe9 / 255, 0xec / 255);
const STRONG = rgb(0x8c / 255, 0x91 / 255, 0x9b / 255);
const SOFT = rgb(0xf5 / 255, 0xf6 / 255, 0xf7 / 255);
const WHITE = rgb(1, 1, 1);

function hex(h: string): Color {
  const n = Number.parseInt(h.replace("#", ""), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

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

type TextOpts = { size?: number; font?: PDFFont; color?: Color; url?: string; indent?: number; gap?: number; bullet?: boolean; lh?: number };

/**
 * Пише в колонку [x, x + width] згори вниз. Колонка скінчилась: нова сторінка, і далі текст іде
 * на всю ширину (права панель лишається лише на першій).
 */
class Writer {
  page: PDFPage;
  y: number;
  x = M;
  width = A4[0] - 2 * M;
  /** Нижня межа колонки на поточній сторінці. */
  bottom = M;

  constructor(
    private readonly doc: PDFDocument,
    readonly f: Fonts,
  ) {
    this.page = doc.addPage(A4);
    this.y = A4[1] - M;
  }

  ensure(h: number) {
    if (this.y - h < this.bottom) {
      this.page = this.doc.addPage(A4);
      this.y = A4[1] - M;
      this.x = M;
      this.width = A4[0] - 2 * M;
      this.bottom = M + 20;
    }
  }

  measure(text: string, size: number, font: PDFFont): number {
    return runs(text, font, this.f).reduce((w, r) => w + r.font.widthOfTextAtSize(r.text, size), 0);
  }

  drawAt(text: string, x: number, y: number, size: number, font: PDFFont, color: Color = INK): number {
    let cx = x;
    for (const r of runs(text, font, this.f)) {
      this.page.drawText(r.text, { x: cx, y, size, font: r.font, color });
      cx += r.font.widthOfTextAtSize(r.text, size);
    }
    return cx - x;
  }

  /** Рядки з переносом слів; довге слово (адреса) ріжеться по символах. */
  wrap(text: string, size: number, font: PDFFont, max: number): string[] {
    const lines: string[] = [];
    for (const para of text.split(/\n+/)) {
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
    }
    return lines;
  }

  text(text: string, opts: TextOpts = {}) {
    const size = opts.size ?? 10;
    const font = opts.font ?? this.f.sans;
    const lh = opts.lh ?? size * 1.42;
    const indent = opts.indent ?? 0;
    for (const [i, line] of this.wrap(text, size, font, this.width - indent).entries()) {
      this.ensure(lh);
      this.y -= lh;
      const x = this.x + indent;
      // Маркер квадратиком: у підмножинах шрифтів немає «•».
      if (opts.bullet && i === 0) this.page.drawRectangle({ x: x - 9, y: this.y + size * 0.62, width: 3, height: 3, color: INK });
      const w = this.drawAt(line, x, this.y + size * 0.3, size, font, opts.color);
      if (opts.url) this.link(x, this.y, w, lh, opts.url);
    }
    this.y -= opts.gap ?? 0;
  }

  /** Підпис розділу: дрібні великі літери й риска кольору тексту. */
  label(text: string, opts: { top?: number } = {}) {
    this.ensure(34);
    this.y -= opts.top ?? 16;
    this.page.drawRectangle({ x: this.x, y: this.y, width: 14, height: 1.6, color: INK });
    this.y -= 3;
    this.text(text.toUpperCase(), { size: 7.5, font: this.f.display, color: MUTED, gap: 3 });
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

/**
 * Печатка рівня, як на картці (напрям D): диск кольору обробки, кільце на кожен рівень, у білому
 * крузі бал. Центр (cx, cy), радіус r.
 */
function seal(w: Writer, cx: number, cy: number, r: number, score: number, level: number) {
  const tier = tierFor(level);
  const ring = hex(tier.frameInk);
  w.page.drawCircle({ x: cx, y: cy, size: r, color: hex(tier.frame) });
  // Зубці по краю: печатка, а не просто коло.
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    w.page.drawLine({
      start: { x: cx + Math.cos(a) * (r - 4), y: cy + Math.sin(a) * (r - 4) },
      end: { x: cx + Math.cos(a) * (r - 1), y: cy + Math.sin(a) * (r - 1) },
      thickness: 0.7,
      color: ring,
      opacity: 0.55,
    });
  }
  const inner = r * 0.52;
  const band = r - 7 - inner;
  for (let i = 0; i < level; i++) {
    w.page.drawCircle({ x: cx, y: cy, size: inner + ((i + 0.5) * band) / Math.max(level, 1), borderColor: ring, borderWidth: 0.45, borderOpacity: 0.5 });
  }
  w.page.drawCircle({ x: cx, y: cy, size: inner, color: WHITE, borderColor: INK, borderWidth: 1.2 });
  const s = String(score);
  const size = inner * 0.95;
  w.drawAt(s, cx - w.measure(s, size, w.f.display) / 2, cy - size * 0.2, size, w.f.display);
  const lv = `LEVEL ${level}`;
  w.drawAt(lv, cx - w.measure(lv, 6, w.f.display) / 2, cy - inner * 0.62, 6, w.f.display, MUTED);
}

/** Розбір балу смужками: частка кожного джерела від його ваги. */
function breakdown(w: Writer, back: CardBack) {
  const barW = w.width;
  for (const l of back.lines) {
    w.ensure(30);
    const bonus = l.kind === "bonus";
    const name = bonus ? `${l.name} (bonus)` : l.name;
    const right = l.value === null ? "no data" : `${bonus ? "+" : ""}${pts(l.points)} of ${l.weight}`;
    w.y -= 13;
    w.drawAt(name, w.x, w.y, 9, w.f.sans);
    const rw = w.measure(right, 9, w.f.sans);
    w.drawAt(right, w.x + barW - rw, w.y, 9, w.f.sans, l.value === null ? MUTED : INK);
    w.y -= 8;
    w.page.drawRectangle({ x: w.x, y: w.y, width: barW, height: 4, color: LINE });
    const frac = l.value === null || l.weight <= 0 ? 0 : Math.max(0, Math.min(1, l.points / l.weight));
    if (frac > 0) w.page.drawRectangle({ x: w.x, y: w.y, width: barW * frac, height: 4, color: bonus ? STRONG : INK });
    w.y -= 3;
  }
  w.y -= 12;
  const total = `Main ${pts(back.core)} + bonus ${pts(back.bonus)}`;
  w.drawAt(total, w.x, w.y, 9, w.f.display);
  w.y -= 12;
  w.drawAt(`Data coverage ${Math.round(back.cover)}%`, w.x, w.y, 8, w.f.sans, MUTED);
  if (back.note) {
    w.y -= 2;
    w.text(back.note, { size: 8, color: MUTED });
  }
}

/** Контакти пігулками в один рядок (переходять на новий, якщо не вміщаються). */
function pills(w: Writer, items: { text: string; url: string }[], maxRight: number) {
  const h = 20;
  let x = w.x;
  let y = w.y - h;
  for (const it of items) {
    const tw = w.measure(it.text, 9, w.f.sans);
    const pw = tw + 20;
    if (x + pw > maxRight && x > w.x) {
      x = w.x;
      y -= h + 6;
    }
    w.page.drawRectangle({ x, y, width: pw, height: h, borderColor: INK, borderWidth: 0.9, color: WHITE });
    w.drawAt(it.text, x + 10, y + 6.6, 9, w.f.sans);
    w.link(x, y, pw, h, it.url);
    x += pw + 6;
  }
  w.y = y;
}

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
  const [PW, PH] = A4;

  // Верхній рядок: бренд і дата, під ним риска.
  const brand = "NEXTCRYPTOJOB · PROOF OF WORK";
  w.drawAt(brand, M, PH - M - 8, 7.5, display, MUTED);
  const issued = `Issued ${card.issuedOn}`;
  w.drawAt(issued, PW - M - w.measure(issued, 7.5, display), PH - M - 8, 7.5, display, MUTED);
  w.page.drawRectangle({ x: M, y: PH - M - 16, width: PW - 2 * M, height: 1.6, color: INK });

  // Шапка: ім'я, роль, ролі й місце; праворуч печатка.
  const SEAL_R = 50;
  const sealCx = PW - M - SEAL_R;
  const headTop = PH - M - 24;
  seal(w, sealCx, headTop - SEAL_R - 4, SEAL_R, card.score, card.level);
  const headRight = sealCx - SEAL_R - 20;
  w.y = headTop - 4;
  w.width = headRight - M;
  w.text(card.displayName, { size: 30, font: display, lh: 36 });
  w.text(`${card.roleName}, score ${card.score} of 100`, { size: 13, lh: 20 });
  const meta = [view.roles.join(", "), view.place].filter(Boolean).join(" · ");
  if (meta) w.text(meta, { size: 10, color: MUTED, lh: 16 });
  const contacts: { text: string; url: string }[] = [];
  if (view.contact.telegram) contacts.push({ text: `Telegram ${view.contact.telegram.label}`, url: view.contact.telegram.url });
  if (view.contact.email) contacts.push({ text: view.contact.email, url: `mailto:${view.contact.email}` });
  if (contacts.length) {
    w.y -= 8;
    pills(w, contacts, headRight);
  }
  w.y = Math.min(w.y, headTop - 2 * SEAL_R - 8) - 18;
  w.page.drawRectangle({ x: M, y: w.y, width: PW - 2 * M, height: 0.6, color: LINE });

  // Права панель: розбір балу, посилання, перевірка. Малюємо першою, щоб знати її висоту.
  const bodyTop = w.y - 14;
  const sideX = PW - M - SIDE_W;
  const PAD = 14;
  const sideH = bodyTop - M - 18;
  w.page.drawRectangle({ x: sideX, y: bodyTop - sideH, width: SIDE_W, height: sideH, color: SOFT });
  w.x = sideX + PAD;
  w.width = SIDE_W - 2 * PAD;
  w.y = bodyTop - PAD + 16;
  w.bottom = bodyTop - sideH + PAD;
  if (card.back) {
    w.label("How the score is built");
    breakdown(w, card.back);
  }
  // Перевірка внизу панелі; посилання лише доти, доки не доходять до неї.
  const QR = 78;
  const qrTop = bodyTop - sideH + PAD + QR + 34;
  w.bottom = qrTop + 30;
  if (view.links.length && w.y - 60 > w.bottom) {
    w.label("Links", { top: 22 });
    for (const l of view.links.slice(0, 6)) {
      if (w.y - 30 < w.bottom) break;
      w.text(l.label, { size: 9, font: display, url: l.url, lh: 13 });
      w.text(l.url.replace(/^https?:\/\//, ""), { size: 8, color: MUTED, url: l.url, lh: 11, gap: 3 });
    }
  }
  {
    w.page.drawRectangle({ x: w.x, y: qrTop + 18, width: 14, height: 1.6, color: INK });
    w.drawAt("VERIFY", w.x, qrTop + 6, 7.5, display, MUTED);
    w.qr(verifyUrl, w.x, qrTop, QR);
    const vy = qrTop - QR - 12;
    w.drawAt("Scan for the live score", w.x, vy, 8, sans, MUTED);
    w.drawAt(`and the data behind it.`, w.x, vy - 10, 8, sans, MUTED);
  }

  // Ліва колонка: слова людини, далі докази. Перелилось: нова сторінка на всю ширину.
  w.x = M;
  w.width = sideX - GUTTER - M;
  w.y = bodyTop + 16;
  w.bottom = M + 20;
  for (const item of view.words) {
    w.label(item.label);
    w.text(item.text, { size: 11, lh: 16, gap: 2 });
  }
  if (view.groups.length || view.wallets.length) w.label("Proof from public data", { top: 22 });
  for (const g of view.groups) {
    w.ensure(40);
    w.y -= 14;
    const tw = w.drawAt(g.title, w.x, w.y, 12, display);
    if (g.link) {
      const lx = w.x + tw + 8;
      const lw = w.drawAt(g.link.label, lx, w.y, 9, sans, MUTED);
      w.link(lx, w.y - 2, lw, 12, g.link.url);
    }
    w.y -= 4;
    for (const l of g.lines) w.text(l.text, { size: 10, indent: 12, bullet: true, lh: 15 });
    w.y -= 4;
  }
  if (view.wallets.length) {
    w.ensure(40);
    w.y -= 14;
    w.drawAt("Wallet addresses", w.x, w.y, 12, display);
    w.y -= 4;
    for (const a of view.wallets) w.text(a, { size: 8.5, color: MUTED, lh: 12 });
  }

  // Підвал на кожній сторінці.
  const pages = doc.getPages();
  for (const [i, page] of pages.entries()) {
    const foot = `Built from public data by NextCryptoJob. Score formula ${card.formulaVersion}.`;
    page.drawRectangle({ x: M, y: M - 2, width: PW - 2 * M, height: 0.6, color: LINE });
    w.page = page;
    w.drawAt(foot, M, M - 14, 7.5, sans, MUTED);
    const right = pages.length > 1 ? `Page ${i + 1} of ${pages.length}` : "nextcryptojob.xyz";
    w.drawAt(right, PW - M - w.measure(right, 7.5, sans), M - 14, 7.5, sans, MUTED);
  }

  return doc.save();
}
