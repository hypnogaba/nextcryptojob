import { describe, expect, it } from "vitest";
import { isAllowedDisplayNameChar } from "./display-name";
import plexMono from "./fonts/plex-mono-500";
import plexSans from "./fonts/plex-sans-600";
import unbounded from "./fonts/unbounded-600";
import { ROLES } from "./roles";

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
  it("Unbounded has every digit of the score", () => {
    expect(missing(codepoints(unbounded), "0123456789")).toEqual([]);
  });

  it("Plex Mono has every role label, level and the site mark", () => {
    const labels = Object.values(ROLES).map((r) => r.name.toUpperCase()).join("");
    expect(missing(codepoints(plexMono), `${labels}Level 0123456789 / 10/100nextcryptojob.xyz`)).toEqual([]);
  });

  it("Plex Sans has every character a display name may use", () => {
    const allowed = Array.from({ length: 0x500 }, (_, cp) => String.fromCodePoint(cp)).filter(
      isAllowedDisplayNameChar,
    );
    expect(allowed.length).toBeGreaterThan(300);
    expect(missing(codepoints(plexSans), `${allowed.join("")}\u2026`)).toEqual([]);
  });
});
