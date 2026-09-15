"use client";

import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { FIELD, HINT, LABEL, TEXTAREA } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { CONTACT_MESSAGE_MAX } from "@/lib/contact";
import { submitContactAction, type ContactState } from "./actions";

const TOPICS: { value: string; label: string }[] = [
  { value: "candidate", label: "Candidate" },
  { value: "company", label: "Company" },
  { value: "press", label: "Press" },
  { value: "other", label: "Other" },
];

/** Форма /contact: email, тема, текст. Приховане поле "website" - honeypot для ботів. */
export function ContactForm() {
  const [state, action] = useActionState(submitContactAction, {} as ContactState);
  if (state.message?.tone === "success") return <FormMessageLine message={state.message} className="text-base" />;
  return (
    <form action={action} className="grid gap-4">
      <div
        aria-hidden="true"
        style={{ position: "absolute", left: "-5000px", width: "1px", height: "1px", overflow: "hidden" }}
      >
        <label htmlFor="contact-website">Leave this field empty</label>
        <input id="contact-website" name="website" type="text" tabIndex={-1} autoComplete="off" defaultValue="" />
      </div>

      <label htmlFor="contact-email" className={LABEL}>
        Your email
      </label>
      <input
        id="contact-email"
        name="email"
        type="email"
        required
        autoComplete="email"
        defaultValue={state.values?.email}
        className={FIELD}
      />

      <fieldset className="grid gap-2">
        <legend className={LABEL}>Topic</legend>
        <div className="flex flex-wrap gap-4">
          {TOPICS.map((t) => (
            <label key={t.value} className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink">
              <input
                type="radio"
                name="topic"
                value={t.value}
                required
                defaultChecked={(state.values?.topic ?? "candidate") === t.value}
                className="size-4 accent-[var(--brand)]"
              />
              {t.label}
            </label>
          ))}
        </div>
      </fieldset>

      <label htmlFor="contact-message" className={LABEL}>
        Message
      </label>
      <textarea
        id="contact-message"
        name="message"
        required
        rows={6}
        maxLength={CONTACT_MESSAGE_MAX}
        defaultValue={state.values?.message}
        className={TEXTAREA}
      />
      <p className={HINT}>We read every message and reply by email.</p>

      <SubmitButton pendingLabel="Sending..." size="lg" className="w-fit">
        Send message
      </SubmitButton>
      <FormMessageLine message={state.message} />
    </form>
  );
}
