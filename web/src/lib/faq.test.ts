import { describe, expect, it } from "vitest";
import { FAQ, faqJsonLd, faqPlainText } from "./faq";

/** FAQPage: розмітка для пошуку виходить з того самого переліку, що малює сторінка. */
describe("faq", () => {
  it("builds FAQPage JSON-LD from the same items the page renders", () => {
    const ld = faqJsonLd();
    expect(ld["@type"]).toBe("FAQPage");
    expect(ld.mainEntity).toHaveLength(FAQ.length);
    FAQ.forEach((item, i) => {
      expect(ld.mainEntity[i].name).toBe(item.q);
      expect(ld.mainEntity[i].acceptedAnswer.text).toBe(faqPlainText(item.a));
    });
  });

  it("flattens links to their text and keeps the wording", () => {
    const score = FAQ.find((i) => i.q === "How does the score work?")!;
    const text = faqPlainText(score.a);
    expect(text).toContain("is on How your score works, and you can see it live at /scoring.");
    expect(text).not.toContain("/how-scoring-works");
  });
});
