import { normaliseEmail } from "@/lib/auth/email-code";
import { newId } from "@/lib/ids";
import { sqlTime } from "@/lib/time";
import type { Limits } from "@/lib/auth/ratelimit";

/**
 * /contact (A, docs/plans/2026-09-15-launch-readiness.md): форма з полями email, тема,
 * текст, honeypot і обмеження частоти за IP. Записи в contact_messages (0023).
 *
 * Honeypot: приховане поле, яке людина не бачить і не заповнює; форма-бот майже завжди
 * заповнює все. Заповнене поле = тихо ігноруємо (не пишемо в базу, не рахуємо спробу
 * обмеження частоти), відповідь людині та сама, що після успіху: бот не має дізнатись,
 * що його розпізнали.
 */

export const CONTACT_TOPICS = ["candidate", "company", "press", "other"] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];

export function isContactTopic(v: unknown): v is ContactTopic {
  return typeof v === "string" && (CONTACT_TOPICS as readonly string[]).includes(v);
}

export const CONTACT_MESSAGE_MAX = 4000;
export const CONTACT_MESSAGE_MIN = 10;

/** 5 листів на годину з однієї IP: досить людині, мало для засмічення. */
export const CONTACT_IP_LIMITS: Limits = { windowMinutes: 60, maxAttempts: 5, blockMinutes: 60 };

export type SubmitContactInput = {
  email: unknown;
  topic: unknown;
  message: unknown;
  /** Значення прихованого поля форми; не порожнє = бот. */
  honeypot: unknown;
};

export type SubmitContactResult =
  | { ok: true; id: string | null }
  | { ok: false; reason: "invalid_email" | "invalid_topic" | "message_too_short" | "message_too_long" };

/** Перевіряє й записує лист. Обмеження частоти перевіряє викликач (той самий ключ, що auth_attempts). */
export async function submitContact(db: D1Database, input: SubmitContactInput, now: Date = new Date()): Promise<SubmitContactResult> {
  if (typeof input.honeypot === "string" && input.honeypot.trim().length > 0) {
    // Бот: удаємо успіх, нічого не пишемо.
    return { ok: true, id: null };
  }
  const email = normaliseEmail(input.email);
  if (!email) return { ok: false, reason: "invalid_email" };
  if (!isContactTopic(input.topic)) return { ok: false, reason: "invalid_topic" };
  const message = typeof input.message === "string" ? input.message.trim() : "";
  if (message.length < CONTACT_MESSAGE_MIN) return { ok: false, reason: "message_too_short" };
  if (message.length > CONTACT_MESSAGE_MAX) return { ok: false, reason: "message_too_long" };

  const id = newId("msg");
  await db
    .prepare("INSERT INTO contact_messages (id, email, topic, message, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, email, input.topic, message, sqlTime(now))
    .run();
  return { ok: true, id };
}

export type ContactMessageRow = {
  id: string;
  email: string;
  topic: ContactTopic;
  message: string;
  createdAt: string;
  answeredAt: string | null;
};

type Row = { id: string; email: string; topic: string; message: string; created_at: string; answered_at: string | null };

export type ContactList = { messages: ContactMessageRow[]; available: boolean; error: string | null };

/** Список для /admin/messages, найновіші спершу. Таблиці ще немає: порожній список, не помилка сторінки. */
export async function listContactMessages(db: D1Database, limit = 200): Promise<ContactList> {
  try {
    const { results } = await db
      .prepare("SELECT id, email, topic, message, created_at, answered_at FROM contact_messages ORDER BY created_at DESC LIMIT ?")
      .bind(limit)
      .all<Row>();
    return {
      messages: results.map((r) => ({
        id: r.id,
        email: r.email,
        topic: r.topic as ContactTopic,
        message: r.message,
        createdAt: r.created_at,
        answeredAt: r.answered_at,
      })),
      available: true,
      error: null,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) return { messages: [], available: false, error: "Contact messages start after migration 0023 is applied." };
    throw error;
  }
}

export type MarkAnsweredResult = { ok: true } | { ok: false; reason: "not_found" };

/** «Mark answered» / «Mark unanswered» у /admin/messages. */
export async function setContactAnswered(db: D1Database, id: string, answered: boolean, now: Date = new Date()): Promise<MarkAnsweredResult> {
  const res = await db
    .prepare("UPDATE contact_messages SET answered_at = ? WHERE id = ?")
    .bind(answered ? sqlTime(now) : null, id)
    .run();
  return (res.meta.changes ?? 0) > 0 ? { ok: true } : { ok: false, reason: "not_found" };
}
