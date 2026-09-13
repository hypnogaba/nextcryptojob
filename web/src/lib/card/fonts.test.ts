import { describe, expect, it } from "vitest";
import { isAllowedDisplayNameChar } from "./display-name";
import bigShoulders from "./fonts/big-shoulders-800";
import familjen from "./fonts/familjen-grotesk-500";
import cyrillic from "./fonts/ncj-cyrillic-600";
import { POSITION_CODE, SOURCE_CODE } from "@/lib/roles/recipes";
import { ROLES } from "./roles";
import { FINISHES } from "./tiers";

// Мінімальне читання cmap (формати 4 і 12) з TTF: які символи є в шрифті.
// Satori мовчки малює порожнечу на місці відсутньої літери, тож перевіряємо заздалегідь.
function codepoints(base64: string): Set<number> {
  const buf = Buffer.from(base64, "base64");
  const numTables = buf.readUInt16BE(4);
  let cmap = -1;
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    if (buf.toString("latin1", rec, rec + 4) === "cmap") cmap = buf.readUInt32BE(rec + 8);
  }
  if (cmap < 0) throw new Error("no cmap table");
  const out = new Set<number>();
  const subtables = buf.readUInt16BE(cmap + 2);
  for (let i = 0; i < subtables; i++) {
    const off = cmap + buf.readUInt32BE(cmap + 4 + i * 8 + 4);
    const format = buf.readUInt16BE(off);
    if (format === 4) {
      const segX2 = buf.readUInt16BE(off + 6);
      const ends = off + 14;
      const starts = ends + segX2 + 2;
      const deltas = starts + segX2;
      const ranges = deltas + segX2;
      for (let s = 0; s < segX2; s += 2) {
        const end = buf.readUInt16BE(ends + s);
        const start = buf.readUInt16BE(starts + s);
        const delta = buf.readInt16BE(deltas + s);
        const rangeOffset = buf.readUInt16BE(ranges + s);
        for (let c = start; c <= end && c !== 0xffff; c++) {
          const glyph = rangeOffset === 0
            ? (c + delta) & 0xffff
            : buf.readUInt16BE(ranges + s + rangeOffset + (c - start) * 2);
          if (glyph !== 0) out.add(c);
        }
      }
    } else if (format === 12) {
      const groups = buf.readUInt32BE(off + 12);
      for (let g = 0; g < groups; g++) {
        const rec = off + 16 + g * 12;
        const start = buf.readUInt32BE(rec);
        const end = buf.readUInt32BE(rec + 4);
        if (buf.readUInt32BE(rec + 8) === 0 && start === end) continue;
        for (let c = start; c <= end; c++) out.add(c);
      }
    }
  }
  return out;
}

function missing(font: Set<number>, text: string): string[] {
  return [...new Set(text)].filter((ch) => ch !== " " && !font.has(ch.codePointAt(0)!));
}

describe("card fonts", () => {
  const display = codepoints(bigShoulders);
  const text = codepoints(familjen);
  const cyr = codepoints(cyrillic);

  it("Big Shoulders has every digit, role, position code, source code, finish and the site mark", () => {
    const labels = [
      ...Object.values(ROLES).map((r) => r.name.toUpperCase()),
      ...Object.values(POSITION_CODE),
      ...Object.values(SOURCE_CODE),
      ...FINISHES.map((f) => f.name.toUpperCase()),
    ].join("");
    expect(missing(display, `0123456789${labels}LEVEL SEASON No. RATED gap /NEXTCRYPTOJOB.XYZ`)).toEqual([]);
  });

  it("Familjen Grotesk has the reason line", () => {
    expect(missing(text, "Level 0123456789 of 10, black finish. Built from GitHub 74.2, X and an onchain bonus. Wallets not verified.")).toEqual([]);
  });

  it("Big Shoulders or the Cyrillic fallback has every character a display name may use", () => {
    const allowed = Array.from({ length: 0x500 }, (_, cp) => String.fromCodePoint(cp)).filter(
      isAllowedDisplayNameChar,
    );
    expect(allowed.length).toBeGreaterThan(300);
    // Ім'я на картці пишемо прописними, тож перевіряємо обидва регістри. Виняток: ŉ
    // прописною стає «ʼN», і апострофа U+02BC немає ні в одному шрифті (N буде).
    const both = (allowed.join("") + allowed.join("").toUpperCase() + "\u2026").replace(/\u02BC/g, "");
    const union = new Set([...display, ...cyr]);
    expect(missing(union, both)).toEqual([]);
  });

  it("keeps the fallback to Cyrillic and the four letters Big Shoulders lacks, so it stays small", () => {
    const extra = new Set([0x20, 0x132, 0x133, 0x149, 0x17f]);
    expect([...cyr].every((cp) => extra.has(cp) || (cp >= 0x400 && cp <= 0x491))).toBe(true);
  });
});
