"use client";

import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { FIELD, HINT, LABEL, TEXTAREA } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { TEXT_MAX } from "@/lib/testimonials";
import { submitFeedbackAction, type FeedbackState } from "@/app/feedback/actions";

/**
 * Форма відгуку «Got a job through NextCryptoJob? Tell us» (B). Reusable: /feedback
 * підключає її і для гостя, і для підключеного (prefill з акаунта). Хто відповідає,
 * бере лише сервер (currentUser() у server action), не приховане поле форми.
 */
export function TestimonialForm({ defaultDisplayName = "", hasXHandle = false }: { defaultDisplayName?: string; hasXHandle?: boolean }) {
  const [state, action] = useActionState(submitFeedbackAction, {} as FeedbackState);
  if (state.message?.tone === "success") return <FormMessageLine message={state.message} className="text-base" />;
  return (
    <form action={action} className="grid gap-4">
      <label htmlFor="tf-text" className={LABEL}>
        What happened?
      </label>
      <textarea
        id="tf-text"
        name="text"
        required
        rows={5}
        maxLength={TEXT_MAX}
        placeholder="I found a role as a Security auditor through my card and got hired in three weeks."
        className={TEXTAREA}
      />

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <label htmlFor="tf-company" className={LABEL}>
            Company (optional)
          </label>
          <input id="tf-company" name="company" type="text" maxLength={120} className={FIELD} />
        </div>
        <div className="grid gap-2">
          <label htmlFor="tf-role" className={LABEL}>
            Role (optional)
          </label>
          <input id="tf-role" name="role" type="text" maxLength={120} className={FIELD} />
        </div>
      </div>

      <div className="grid gap-2">
        <label htmlFor="tf-name" className={LABEL}>
          Your name (optional)
        </label>
        <input id="tf-name" name="display_name" type="text" maxLength={120} defaultValue={defaultDisplayName} className={FIELD} />
      </div>

      <fieldset className="grid gap-2">
        <legend className={LABEL}>If we show this publicly, show me as</legend>
        <div className="grid gap-2">
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink">
            <input type="radio" name="display" value="name" required defaultChecked className="size-4 accent-[var(--brand)]" />
            My name
          </label>
          {hasXHandle ? (
            <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink">
              <input type="radio" name="display" value="handle" className="size-4 accent-[var(--brand)]" />
              My X handle
            </label>
          ) : null}
          <label className="flex min-h-11 cursor-pointer items-center gap-2 text-sm text-ink">
            <input type="radio" name="display" value="anonymous" className="size-4 accent-[var(--brand)]" />
            Anonymous
          </label>
        </div>
      </fieldset>

      <label className="flex min-h-11 cursor-pointer items-start gap-2 text-sm text-ink">
        <input type="checkbox" name="consent_public" value="1" className="mt-1 size-4 accent-[var(--brand)]" />
        <span>You can show this on the site. Without this, we only read it ourselves.</span>
      </label>
      <p className={HINT}>We review every story before showing it. Nothing is public until we approve it.</p>

      <SubmitButton pendingLabel="Sending..." size="lg" className="w-fit">
        Send my story
      </SubmitButton>
      <FormMessageLine message={state.message} />
    </form>
  );
}
