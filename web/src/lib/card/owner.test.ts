import { beforeEach, describe, expect, it } from "vitest";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import { isCardOwner } from "./owner";
import { createCard } from "./store";

let t: TestDb;
let slug: string;

beforeEach(async () => {
  t = migratedD1();
  t.raw.exec("INSERT INTO users (id, email) VALUES ('owner', 'o@example.com'), ('other', 'x@example.com')");
  slug = await createCard(t.d1, {
    userId: "owner",
    role: "trader",
    score: 82,
    displayName: "@owner",
    formulaVersion: "v5",
  });
});

describe("isCardOwner (who sees the Share on X button)", () => {
  it("is true only for the person who created the card", async () => {
    await expect(isCardOwner(t.d1, slug, "owner")).resolves.toBe(true);
    await expect(isCardOwner(t.d1, slug, "other")).resolves.toBe(false);
  });

  it("is false for a visitor without a session, without asking the database", async () => {
    t.raw.exec("DROP TABLE cards");
    await expect(isCardOwner(t.d1, slug, null)).resolves.toBe(false);
  });

  it("is false for a revoked card and a malformed slug", async () => {
    await createCard(t.d1, { userId: "owner", role: "trader", score: 90, displayName: "@owner", formulaVersion: "v5" });
    await expect(isCardOwner(t.d1, slug, "owner")).resolves.toBe(false);
    await expect(isCardOwner(t.d1, "' OR 1=1 --", "owner")).resolves.toBe(false);
  });
});
