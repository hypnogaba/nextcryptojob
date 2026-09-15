import { describe, expect, it } from "vitest";
import { crmDb } from "@/test/crm-fixtures";
import { migratedD1 } from "@/test/sqlite-d1";
import { listContactMessages, setContactAnswered, submitContact } from "./contact";

/**
 * /contact (A): honeypot, валідація, запис, «Mark answered», і що код не падає,
 * якщо міграція 0023 ще не накочена (contact_messages немає).
 */

const INPUT = { email: "ada@example.com", topic: "candidate", message: "I would like to know more about the score.", honeypot: "" };

describe("submitContact", () => {
  it("writes a valid message", async () => {
    const { d1 } = crmDb();
    const res = await submitContact(d1, INPUT, new Date("2026-09-15T10:00:00Z"));
    expect(res).toMatchObject({ ok: true });
    if (!res.ok) throw new Error("unreachable");
    const list = await listContactMessages(d1);
    expect(list.available).toBe(true);
    expect(list.messages).toHaveLength(1);
    expect(list.messages[0]).toMatchObject({ email: "ada@example.com", topic: "candidate", answeredAt: null });
  });

  it("honeypot filled: pretends success, writes nothing", async () => {
    const { d1 } = crmDb();
    const res = await submitContact(d1, { ...INPUT, honeypot: "http://spam.example" });
    expect(res.ok).toBe(true);
    const list = await listContactMessages(d1);
    expect(list.messages).toHaveLength(0);
  });

  it("rejects a bad email, an unknown topic, and a too-short or too-long message", async () => {
    const { d1 } = crmDb();
    expect(await submitContact(d1, { ...INPUT, email: "not-an-email" })).toEqual({ ok: false, reason: "invalid_email" });
    expect(await submitContact(d1, { ...INPUT, topic: "banana" })).toEqual({ ok: false, reason: "invalid_topic" });
    expect(await submitContact(d1, { ...INPUT, message: "hi" })).toEqual({ ok: false, reason: "message_too_short" });
    expect(await submitContact(d1, { ...INPUT, message: "x".repeat(4001) })).toEqual({ ok: false, reason: "message_too_long" });
  });

  it("lowercases and trims the email", async () => {
    const { d1 } = crmDb();
    const res = await submitContact(d1, { ...INPUT, email: "  Ada@Example.com  " });
    expect(res.ok).toBe(true);
    const list = await listContactMessages(d1);
    expect(list.messages[0].email).toBe("ada@example.com");
  });
});

describe("setContactAnswered", () => {
  it("marks and unmarks a message", async () => {
    const { d1 } = crmDb();
    const res = await submitContact(d1, INPUT);
    if (!res.ok || !res.id) throw new Error("expected an id");
    expect(await setContactAnswered(d1, res.id, true, new Date("2026-09-15T11:00:00Z"))).toEqual({ ok: true });
    let list = await listContactMessages(d1);
    expect(list.messages[0].answeredAt).toBe("2026-09-15 11:00:00");

    expect(await setContactAnswered(d1, res.id, false)).toEqual({ ok: true });
    list = await listContactMessages(d1);
    expect(list.messages[0].answeredAt).toBeNull();
  });

  it("reports not_found for an unknown id", async () => {
    const { d1 } = crmDb();
    expect(await setContactAnswered(d1, "msg_doesnotexist00000", true)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("listContactMessages without migration 0023", () => {
  it("returns an empty, unavailable list instead of throwing", async () => {
    const { d1 } = migratedD1(); // без 0023_launch
    const list = await listContactMessages(d1);
    expect(list).toEqual({ messages: [], available: false, error: expect.stringContaining("0023") });
  });
});
