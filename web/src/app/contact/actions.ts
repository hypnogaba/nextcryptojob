"use server";

import { headers } from "next/headers";
import type { FormMessage } from "@/components/form/form-message";
import { sendOwnerAlert, type OwnerAlert } from "@/lib/admin/alerts";
import { clientIp, consume } from "@/lib/auth/ratelimit";
import { CONTACT_IP_LIMITS, CONTACT_TOPICS, submitContact, type ContactTopic } from "@/lib/contact";
import { notifierFromEnv } from "@/lib/crm/notify";
import { appEnv, db } from "@/lib/db";

export type ContactState = { message?: FormMessage; values?: { email: string; topic: string; message: string } };

const TOPIC_TITLE: Record<ContactTopic, string> = {
  candidate: "candidate",
  company: "company",
  press: "press",
  other: "other",
};

/**
 * Сповіщення власнику про лист з /contact. Несе пошту автора й текст цілком: у Telegram
 * чи в пошті одразу видно, хто написав і що, і чи треба відповідати, без заходу в адмінку.
 */
function contactAlert(id: string, topic: ContactTopic, from: string, message: string): OwnerAlert {
  return {
    key: `contact:${id}`,
    kind: "contact",
    title: `New contact message (${TOPIC_TITLE[topic]}) from ${from}`,
    from,
    body: message,
    why: "Someone wrote in from /contact and is waiting for a reply.",
    next: `Reply to ${from} by email, then mark it answered in Messages.`,
    href: "/admin/messages",
    windowMs: 365 * 24 * 60 * 60 * 1000,
  };
}

/** Форма /contact: honeypot, обмеження частоти за IP, запис, сповіщення власнику. */
export async function submitContactAction(_prev: ContactState, form: FormData): Promise<ContactState> {
  const email = String(form.get("email") ?? "");
  const topic = String(form.get("topic") ?? "");
  const message = String(form.get("message") ?? "");
  const honeypot = String(form.get("website") ?? "");
  const values = { email, topic, message };

  if (!honeypot) {
    const ip = clientIp(await headers());
    const verdict = await consume(`contact:${ip}`, CONTACT_IP_LIMITS, db());
    if (!verdict.allowed) {
      return { message: { tone: "error", text: `Too many messages from here. Try again in ${verdict.retryAfterMinutes} minutes.` }, values };
    }
  }

  const res = await submitContact(db(), { email, topic, message, honeypot });
  if (!res.ok) {
    const text =
      res.reason === "invalid_email"
        ? "Enter a valid email address."
        : res.reason === "invalid_topic"
          ? `Choose one: ${CONTACT_TOPICS.join(", ")}.`
          : res.reason === "message_too_short"
            ? "Write a few more words."
            : "Keep the message shorter.";
    return { message: { tone: "error", text }, values };
  }

  if (res.id) {
    try {
      await sendOwnerAlert(db(), contactAlert(res.id, topic as ContactTopic, res.email, res.message), {
        notifier: notifierFromEnv(appEnv()),
        adminEmails: (appEnv() as { ADMIN_EMAILS?: string }).ADMIN_EMAILS,
      });
    } catch (error) {
      console.error("contact: owner not notified", error instanceof Error ? error.message : String(error));
    }
  }
  return { message: { tone: "success", text: "Thank you. We read every message and reply by email." } };
}
