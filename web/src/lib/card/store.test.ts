import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "node:sqlite";
import { sqliteD1 } from "@/test/sqlite-d1";
import { CardInputError, createCard, getCard, type NewCard } from "./store";

const INPUT: NewCard = {
  userId: "u1",
  role: "security_auditor",
  score: 72.4,
  displayName: "  alice ",
  formulaVersion: "v5",
};

let db: D1Database;
let raw: DatabaseSync;

beforeEach(() => {
  ({ db, raw } = sqliteD1(["0001_core", "0005_cards", "0024_one_card_per_person"]));
  raw.exec("INSERT INTO users (id, email) VALUES ('u1', 'a@example.com'), ('u2', 'b@example.com')");
});

describe("migration 0005_cards", () => {
  it("records itself in schema_migrations", () => {
    expect(raw.prepare("SELECT name FROM schema_migrations WHERE name = '0005_cards'").get()).toBeTruthy();
  });
});

describe("createCard + getCard", () => {
  it("stores a card and reads it back by slug with the level computed", async () => {
    const slug = await createCard(db, INPUT);
    const card = await getCard(db, slug);
    expect(card).toMatchObject({
      slug,
      role: "security_auditor",
      score: 72.4,
      level: 8,
      displayName: "alice",
      formulaVersion: "v5",
    });
    expect(card?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("never exposes who owns the card", async () => {
    const card = await getCard(db, await createCard(db, INPUT));
    expect(card).not.toHaveProperty("userId");
    expect(card).not.toHaveProperty("user_id");
  });

  it("keeps one active card per person, same role: a new card revokes the old one and redirects to it", async () => {
    const first = await createCard(db, INPUT);
    const second = await createCard(db, { ...INPUT, score: 81 });
    expect(await getCard(db, first)).toBeNull();
    expect((await getCard(db, second))?.level).toBe(9);

    const revoked = raw.prepare("SELECT revoked_at, redirect_to FROM cards WHERE slug = ?").get(first) as {
      revoked_at: string;
      redirect_to: string;
    };
    expect(revoked.revoked_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(revoked.redirect_to).toBe(second);
  });

  // Раунд 5, п.7: ОДНА КАРТКА НА ЛЮДИНУ, не на людину й роль. Нова картка іншої ролі теж
  // відкликає стару, і стара адреса веде на нову; інша людина не зачеплена.
  it("one card per person (item 7): a card for another role revokes the previous one, but leaves other people alone", async () => {
    const auditor = await createCard(db, INPUT);
    const engineer = await createCard(db, { ...INPUT, role: "engineer" });
    const other = await createCard(db, { ...INPUT, userId: "u2" });

    expect(await getCard(db, auditor)).toBeNull();
    expect(await getCard(db, engineer)).not.toBeNull();
    expect(await getCard(db, other)).not.toBeNull();
    const redirected = raw.prepare("SELECT redirect_to FROM cards WHERE slug = ?").get(auditor) as { redirect_to: string };
    expect(redirected.redirect_to).toBe(engineer);
  });

  it("returns null for a missing, malformed or revoked slug", async () => {
    expect(await getCard(db, "aaaaaaaaaa")).toBeNull();
    expect(await getCard(db, "' OR 1=1 --")).toBeNull();
    const slug = await createCard(db, INPUT);
    raw.prepare("UPDATE cards SET revoked_at = datetime('now') WHERE slug = ?").run(slug);
    expect(await getCard(db, slug)).toBeNull();
  });

  it("disappears with the account", async () => {
    const slug = await createCard(db, INPUT);
    raw.exec("DELETE FROM users WHERE id = 'u1'");
    expect(await getCard(db, slug)).toBeNull();
    expect(raw.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 0 });
  });

  it("the database itself refuses a second active card for the same person, even a different role (item 7)", () => {
    const insert = (slug: string, role: string) =>
      raw
        .prepare(
          "INSERT INTO cards (slug, user_id, role, score, level, display_name, formula_version) VALUES (?, 'u1', ?, 50, 6, 'a', 'v5')",
        )
        .run(slug, role);
    insert("aaaaaaaaaa", "engineer");
    expect(() => insert("bbbbbbbbbb", "engineer")).toThrow(/UNIQUE/);
    expect(() => insert("cccccccccc", "bd")).toThrow(/UNIQUE/);
  });

  it.each([
    [{ role: "wizard" }, /Unknown role/],
    [{ score: 101 }, /between 0 and 100/],
    [{ score: -1 }, /between 0 and 100/],
    [{ score: Number.NaN }, /between 0 and 100/],
    [{ userId: "" }, /userId/],
    [{ formulaVersion: "" }, /formulaVersion/],
    [{ displayName: "0x52908400098527886E0F7030069857D2E4169EE7" }, /wallet/],
  ] as const)("rejects %j", async (patch, message) => {
    await expect(createCard(db, { ...INPUT, ...patch })).rejects.toThrow(CardInputError);
    await expect(createCard(db, { ...INPUT, ...patch })).rejects.toThrow(message);
    expect(raw.prepare("SELECT COUNT(*) AS n FROM cards").get()).toEqual({ n: 0 });
  });

  it("does not create a card for an unknown person", async () => {
    await expect(createCard(db, { ...INPUT, userId: "ghost" })).rejects.toThrow(/FOREIGN KEY/);
  });
});
