import { describe, expect, it } from "vitest";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFString } from "pdf-lib";
import { renderProfilePdf } from "./pdf";
import type { ProfileView } from "./profile";

const VIEW: ProfileView = {
  mode: "full",
  roles: ["Engineer"],
  place: "Remote or Київ",
  groups: [
    {
      key: "github",
      title: "GitHub",
      link: { label: "github.com/ada", url: "https://github.com/ada" },
      lines: Array.from({ length: 40 }, (_, i) => ({ id: `github.l${i}`, text: `Line ${i} with a fairly long description`, hidden: false })),
    },
  ],
  words: [{ id: "words.target", label: "What they are looking for", text: "Шукаю роботу в протоколі 🚀", hidden: false }],
  links: [{ label: "Talk", url: "https://ex.org/t" }],
  contact: { telegram: { label: "@ada", url: "https://t.me/ada" }, email: "ada@example.com" },
  wallets: ["0xABCDEF0000000000000000000000000000000001"],
};

describe("renderProfilePdf", () => {
  it("makes a valid multi-page PDF with clickable links and odd characters", async () => {
    const bytes = await renderProfilePdf(
      { displayName: "Ада", roleName: "Engineer", score: 71, level: 8, formulaVersion: "v6", issuedOn: "16 Sep 2026", back: null },
      VIEW,
      "https://nextcryptojob.xyz/c/abc?k=0123",
    );
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe("%PDF-");
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);
    expect(doc.getTitle()).toBe("Ада: Engineer, score 71");
    const uris = doc.getPages().flatMap((p) => {
      const annots = p.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
      if (!annots) return [];
      return annots.asArray().map((ref) => {
        const action = doc.context.lookup(ref, PDFDict).lookup(PDFName.of("A"), PDFDict);
        return action.lookup(PDFName.of("URI"), PDFString).decodeText();
      });
    });
    expect(uris).toEqual(
      expect.arrayContaining([
        "https://nextcryptojob.xyz/c/abc?k=0123",
        "https://github.com/ada",
        "https://t.me/ada",
        "mailto:ada@example.com",
        "https://ex.org/t",
      ]),
    );
  });
});
