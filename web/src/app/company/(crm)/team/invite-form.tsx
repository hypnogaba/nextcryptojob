"use client";

import { useActionState, useState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR, FIELD, HINT, LABEL } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { inviteAction, type InviteState } from "./actions";

function CopyLink({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="grid gap-2">
      <label htmlFor="invite-link" className={LABEL}>
        Invite link
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input id="invite-link" readOnly value={link} onFocus={(e) => e.currentTarget.select()} className={`${FIELD} font-mono text-sm`} />
        <Button
          type="button"
          variant="outline"
          className="h-11 px-4 text-base"
          onClick={() => {
            void navigator.clipboard?.writeText(link).then(() => setCopied(true));
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <p className={HINT}>The link works once, for 7 days, and only for someone who signs in with that email.</p>
    </div>
  );
}

export function InviteForm({ seatsLeft, companyId }: { seatsLeft: number; companyId: string }) {
  const [state, action] = useActionState(inviteAction, {} as InviteState);
  return (
    <div className="grid gap-4">
      <form action={action} className="grid gap-3" noValidate>
        <input type="hidden" name="company_id" value={companyId} />
        <div className="grid gap-1.5">
          <label htmlFor="email" className={LABEL}>
            Work email
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="off"
              required
              placeholder="teammate@acme.io"
              defaultValue={state.error ? state.email : undefined}
              aria-invalid={state.error ? true : undefined}
              aria-describedby={state.error ? "email-error" : "email-hint"}
              className={FIELD}
            />
            <SubmitButton pendingLabel="Inviting..." disabled={seatsLeft <= 0} className="h-11 shrink-0 px-5 text-base">
              Invite teammate
            </SubmitButton>
          </div>
          {state.error ? (
            <p id="email-error" role="alert" className={ERROR}>
              {state.error}
            </p>
          ) : (
            <p id="email-hint" className={HINT}>
              {seatsLeft > 0
                ? `${seatsLeft} ${seatsLeft === 1 ? "seat" : "seats"} left. They accept by signing in with this email.`
                : "No seats left. Remove someone or cancel an invite first."}
            </p>
          )}
        </div>
        <FormMessageLine message={state.message} />
      </form>
      {state.link ? <CopyLink link={state.link} /> : null}
    </div>
  );
}
