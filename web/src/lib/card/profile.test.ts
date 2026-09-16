import { describe, expect, it } from "vitest";
import { DEFAULT_PREFS } from "./profile-prefs";
import { type ProfileInput, profileView, short } from "./profile";

const NOW = new Date("2026-09-16T00:00:00Z");
const TS_2020 = Date.UTC(2020, 0, 1) / 1000;

const INPUT: ProfileInput = {
  roles: ["engineer", "devrel"],
  remoteMode: "remote,city",
  city: "Lisbon",
  roleText: "Rust dev at secretcorp",
  targetText: "Looking for protocol work, ping me",
  telegramUsername: "ada_tg",
  email: "ada@example.com",
  identities: [
    { kind: "github", value: "ada-gh" },
    { kind: "x", value: "ada_x" },
    { kind: "evm", value: "0xABCDEF0000000000000000000000000000000001" },
    { kind: "site", value: "https://ada.dev" },
  ],
  facts: [
    {
      user_id: "u1",
      source: "github",
      facts_json: JSON.stringify({
        createdAt: "2019-03-01T00:00:00Z",
        followers: 1234,
        stars: 0,
        commits12m: 850,
        reviews12m: null,
        mergedPrsElsewhere: 38,
        reposPushed12m: 1,
        reposWithSite: 0,
      }),
    },
    { user_id: "u1", source: "x", facts_json: JSON.stringify({ followers: 5000, kol: 12, kolSourceGap: true, own30d: 9 }) },
    {
      user_id: "u1",
      source: "evm",
      facts_json: JSON.stringify({
        "0xabcdef0000000000000000000000000000000001": { ethereum: { sent: 400, firstTs: TS_2020, swaps: 20 }, base: { sent: 0, firstTs: null } },
      }),
    },
    { user_id: "u1", source: "site", facts_json: null },
  ],
  prefs: DEFAULT_PREFS,
  now: NOW,
};

const PERSONAL = ["ada-gh", "ada_x", "0xABCDEF", "0xabcdef", "ada.dev", "ada_tg", "ada@example.com", "secretcorp", "ping me", "Lisbon", "http"];

describe("short", () => {
  it.each([
    [950, "950"],
    [1234, "1.2k"],
    [1500000, "1.5M"],
    [2e9, "2B"],
  ])("%d → %s", (n, s) => expect(short(n)).toBe(s));
});

describe("profileView public", () => {
  const view = profileView(INPUT, "public");

  it("carries facts but nothing that names or reaches the person", () => {
    const json = JSON.stringify(view);
    for (const p of PERSONAL) expect(json).not.toContain(p);
    expect(view.groups.every((g) => g.link === null)).toBe(true);
    expect(view.words).toEqual([]);
    expect(view.links).toEqual([]);
    expect(view.contact).toEqual({ telegram: null, email: null });
    expect(view.wallets).toEqual([]);
    expect(view.place).toBe("Remote or on-site");
  });

  it("prints facts as lines, skipping null and zero", () => {
    const gh = view.groups.find((g) => g.key === "github")!;
    expect(gh.lines.map((l) => l.text)).toEqual([
      "38 merged pull requests in other people's repositories",
      "850 commits in the last 12 months",
      "1 repository updated in the last 12 months",
      "1.2k followers on GitHub",
      "On GitHub since 2019",
    ]);
    const x = view.groups.find((g) => g.key === "x")!;
    // kolSourceGap: число kol не з джерела, рядка немає.
    expect(x.lines.map((l) => l.id)).toEqual(["x.followers", "x.own30d"]);
  });

  it("never shows onchain activity to a stranger (item 4): no wallets group, no transaction counts", () => {
    expect(view.groups.some((g) => g.key === "wallets")).toBe(false);
    const json = JSON.stringify(view);
    expect(json).not.toContain("transaction");
    expect(json).not.toContain("trade");
    expect(json).not.toContain("Onchain for");
  });

  it("drops sources without facts, and the wallets group even though it has facts", () => {
    expect(view.groups.map((g) => g.key)).toEqual(["github", "x"]);
  });
});

describe("profileView full", () => {
  it("adds links, words and contact, but wallets only on request", () => {
    const view = profileView(INPUT, "full");
    expect(view.groups.find((g) => g.key === "github")!.link).toEqual({ label: "github.com/ada-gh", url: "https://github.com/ada-gh" });
    expect(view.words.map((w) => w.id)).toEqual(["words.role", "words.target"]);
    expect(view.contact.telegram?.url).toBe("https://t.me/ada_tg");
    expect(view.contact.email).toBe("ada@example.com");
    expect(view.place).toBe("Remote or Lisbon");
    expect(view.wallets).toEqual([]);
    expect(profileView({ ...INPUT, prefs: { ...DEFAULT_PREFS, showWallet: true } }, "full").wallets).toEqual([
      "0xABCDEF0000000000000000000000000000000001",
    ]);
  });

  it("drops hidden items in full and public but keeps them flagged for the owner", () => {
    const prefs = { ...DEFAULT_PREFS, hidden: ["github.followers", "words.role"] };
    const input = { ...INPUT, prefs };
    for (const mode of ["public", "full"] as const) {
      const json = JSON.stringify(profileView(input, mode));
      expect(json).not.toContain("github.followers");
      expect(json).not.toContain("words.role");
    }
    const owner = profileView(input, "owner");
    expect(owner.groups[0].lines.find((l) => l.id === "github.followers")?.hidden).toBe(true);
    expect(owner.words.find((w) => w.id === "words.role")?.hidden).toBe(true);
  });

  it("refuses a malformed Telegram name", () => {
    expect(profileView({ ...INPUT, telegramUsername: "a b/c" }, "full").contact.telegram).toBeNull();
  });

  it("still sums onchain activity when the owner unlocked full view with their own key", () => {
    const view = profileView(INPUT, "full");
    const w = view.groups.find((g) => g.key === "wallets")!;
    expect(w.lines.map((l) => l.text)).toEqual(["Onchain for 6+ years", "Active on Ethereum", "400 transactions", "20 trades"]);
  });
});
