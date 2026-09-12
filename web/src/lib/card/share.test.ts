import { describe, expect, it } from "vitest";
import { ROLES, type RoleKey } from "./roles";
import { shareText, xShareUrl } from "./share";

describe("shareText", () => {
  it("says the score, the role and the level", () => {
    expect(shareText({ role: "security_auditor", score: 72 })).toBe(
      "I scored 72 as a Security auditor on NextCryptoJob. Level 8 of 10.",
    );
    expect(shareText({ role: "engineer", score: 100 })).toBe(
      "I scored 100 as an Engineer on NextCryptoJob. Level 10 of 10.",
    );
    expect(shareText({ role: "data_research", score: 79.6 })).toBe(
      "I scored 79 in Data & research on NextCryptoJob. Level 8 of 10.",
    );
  });

  it("never uses an em dash for any role", () => {
    for (const role of Object.keys(ROLES) as RoleKey[]) {
      expect(shareText({ role, score: 55 })).not.toContain("\u2014");
    }
  });
});

describe("xShareUrl", () => {
  it("builds an X intent link with the text and the card address", () => {
    const link = xShareUrl({ slug: "aB3_-x9QzK", role: "security_auditor", score: 72 }, "https://nextcryptojob.xyz");
    const url = new URL(link);
    expect(url.origin + url.pathname).toBe("https://x.com/intent/post");
    expect(url.searchParams.get("text")).toBe(
      "I scored 72 as a Security auditor on NextCryptoJob. Level 8 of 10.",
    );
    expect(url.searchParams.get("url")).toBe("https://nextcryptojob.xyz/c/aB3_-x9QzK");
    expect(link).not.toContain("+");
  });

  it("escapes the ampersand in role names", () => {
    const link = xShareUrl({ slug: "aB3_-x9QzK", role: "bd", score: 40 }, "https://nextcryptojob.xyz");
    expect(link).toContain("BD%20%26%20partnerships");
    const url = new URL(link);
    expect(url.searchParams.get("text")).toBe("I scored 40 in BD & partnerships on NextCryptoJob. Level 5 of 10.");
    expect([...url.searchParams.keys()]).toEqual(["text", "url"]);
  });
});
