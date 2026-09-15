// Константи форми /contact без серверних залежностей: їх бере і клієнтська форма (contact-form.tsx),
// а lib/contact.ts тягне сесію через email-code і в браузер не годиться.

export const CONTACT_TOPICS = ["candidate", "company", "press", "other"] as const;
export type ContactTopic = (typeof CONTACT_TOPICS)[number];

export function isContactTopic(v: unknown): v is ContactTopic {
  return typeof v === "string" && (CONTACT_TOPICS as readonly string[]).includes(v);
}

export const CONTACT_MESSAGE_MAX = 4000;
export const CONTACT_MESSAGE_MIN = 10;
