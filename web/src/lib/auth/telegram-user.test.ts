import { beforeEach, describe, expect, it } from "vitest";
import { setChannel } from "@/lib/telegram/channel";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import { homeFor, linkTelegram, signInWithTelegram } from "./telegram-user";

let t: TestDb;
beforeEach(() => {
  t = migratedD1();
});

const ada = { telegramId: "987654321", username: "ada_l", name: "Ada" };
const user = (id: string) =>
  t.raw.prepare("SELECT id, email, telegram_id, telegram_username, channel FROM users WHERE id = ?").get(id);
const exec = (sql: string, ...params: (string | null)[]) => t.raw.prepare(sql).run(...params);

describe("signInWithTelegram", () => {
  it("creates a Telegram profile on first sign-in", async () => {
    const res = await signInWithTelegram(t.d1, ada);
    expect(res.created).toBe(true);
    expect(user(res.userId)).toEqual({
      id: res.userId,
      email: null,
      telegram_id: "987654321",
      telegram_username: "ada_l",
      channel: "telegram",
    });
  });

  it("finds the same profile next time and keeps the username fresh", async () => {
    const first = await signInWithTelegram(t.d1, ada);
    const again = await signInWithTelegram(t.d1, { ...ada, username: "ada_new" });
    expect(again).toEqual({ userId: first.userId, created: false });
    expect(user(first.userId)).toMatchObject({ telegram_username: "ada_new" });
    expect(t.raw.prepare("SELECT COUNT(*) AS n FROM users").get()).toEqual({ n: 1 });
  });

  it("finds a profile that linked Telegram from email", async () => {
    exec("INSERT INTO users (id, email, telegram_id) VALUES ('u1', 'ada@example.com', '987654321')");
    await expect(signInWithTelegram(t.d1, ada)).resolves.toEqual({ userId: "u1", created: false });
  });
});

describe("linkTelegram", () => {
  beforeEach(() => {
    exec("INSERT INTO users (id, email) VALUES ('u1', 'ada@example.com')");
  });

  it("links a free Telegram to the signed-in profile without changing the channel", async () => {
    await expect(linkTelegram(t.d1, "u1", ada)).resolves.toBe("linked");
    expect(user("u1")).toMatchObject({ telegram_id: "987654321", telegram_username: "ada_l", channel: "email" });
  });

  it("is a no-op when the same Telegram is already linked", async () => {
    await linkTelegram(t.d1, "u1", ada);
    await expect(linkTelegram(t.d1, "u1", ada)).resolves.toBe("already_linked");
  });

  it("refuses a Telegram that belongs to another profile", async () => {
    exec("INSERT INTO users (id, telegram_id) VALUES ('u2', '987654321')");
    await expect(linkTelegram(t.d1, "u1", ada)).resolves.toBe("taken");
    expect(user("u1")).toMatchObject({ telegram_id: null });
    expect(user("u2")).toMatchObject({ telegram_id: "987654321" });
  });

  it("does not replace a different Telegram already on the profile", async () => {
    exec("UPDATE users SET telegram_id = '111' WHERE id = 'u1'");
    await expect(linkTelegram(t.d1, "u1", ada)).resolves.toBe("has_other_telegram");
    expect(user("u1")).toMatchObject({ telegram_id: "111" });
  });
});

describe("homeFor", () => {
  it("sends people who finished onboarding to /profile, others to /account", async () => {
    exec("INSERT INTO users (id, onboarding_step) VALUES ('done', 'done'), ('mid', 'roles'), ('new', NULL)");
    await expect(homeFor(t.d1, "done")).resolves.toBe("/profile");
    await expect(homeFor(t.d1, "mid")).resolves.toBe("/account");
    await expect(homeFor(t.d1, "new")).resolves.toBe("/account");
  });
});

describe("setChannel", () => {
  it("switches to Telegram only when Telegram is linked", async () => {
    exec("INSERT INTO users (id, email) VALUES ('e', 'e@example.com')");
    await expect(setChannel(t.d1, "e", "telegram")).resolves.toBe("not_linked");
    exec("UPDATE users SET telegram_id = '5' WHERE id = 'e'");
    await expect(setChannel(t.d1, "e", "telegram")).resolves.toBe("changed");
    expect(user("e")).toMatchObject({ channel: "telegram" });
    await expect(setChannel(t.d1, "e", "telegram")).resolves.toBe("unchanged");
    await expect(setChannel(t.d1, "e", "email")).resolves.toBe("changed");
    expect(user("e")).toMatchObject({ channel: "email" });
  });

  it("does not switch to email when there is no email", async () => {
    exec("INSERT INTO users (id, telegram_id, channel) VALUES ('t', '6', 'telegram')");
    await expect(setChannel(t.d1, "t", "email")).resolves.toBe("no_email");
    expect(user("t")).toMatchObject({ channel: "telegram" });
    await expect(setChannel(t.d1, "missing", "email")).resolves.toBe("no_user");
  });
});
