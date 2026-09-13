"use client";

import { useActionState, useState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR, FIELD, HINT, LABEL } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { Button } from "@/components/ui/button";
import { createKeyAction, webhookAction, type CreateKeyState, type WebhookState } from "./actions";

/**
 * Форми сторінки Developers. Ключ і секрет вебхука живуть лише в стані
 * відповіді дії: показуємо один раз з кнопкою "Copy", після перезавантаження їх немає.
 */

function OneTimeSecret({ label, value, note }: { label: string; value: string; note: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div role="status" className="grid gap-2 rounded-lg border border-line-strong bg-wash p-4">
      <p className="text-sm font-medium text-ink">{note}</p>
      <label className="grid gap-1.5">
        <span className={LABEL}>{label}</span>
        <input readOnly value={value} onFocus={(e) => e.currentTarget.select()} className={`${FIELD} font-mono text-sm`} />
      </label>
      <div>
        <Button
          type="button"
          variant="outline"
          className="h-11 px-4"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(value);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </div>
  );
}

export function CreateKeyForm({ companyId, disabled }: { companyId: string; disabled?: boolean }) {
  const [state, action] = useActionState(createKeyAction, {} as CreateKeyState);
  return (
    <div className="grid gap-4">
      {state.created ? (
        <OneTimeSecret label={`API key "${state.created.name}"`} value={state.created.key} note="Copy this key now. You will not see it again." />
      ) : null}
      <form action={action} className="grid gap-3 sm:grid-cols-[1fr_auto] sm:items-end" noValidate>
        <input type="hidden" name="company_id" value={companyId} />
        <div className="grid gap-1.5">
          <label htmlFor="key-name" className={LABEL}>
            Key name
          </label>
          <input
            id="key-name"
            name="name"
            type="text"
            maxLength={60}
            placeholder="sourcing-bot"
            autoComplete="off"
            aria-invalid={state.errors?.name ? true : undefined}
            aria-describedby="key-name-message"
            className={FIELD}
            disabled={disabled}
          />
        </div>
        <SubmitButton className="h-11 px-4" pendingLabel="Creating..." disabled={disabled}>
          Create key
        </SubmitButton>
        <FormMessageLine id="key-name-message" message={state.message} className="sm:col-span-2" />
      </form>
    </div>
  );
}

export function WebhookForm({
  companyId,
  url,
  enabled,
  canWrite,
  configured,
}: {
  companyId: string;
  url: string | null;
  enabled: boolean;
  canWrite: boolean;
  configured: boolean;
}) {
  const [state, action] = useActionState(webhookAction, {} as WebhookState);
  const locked = !canWrite || !configured;
  return (
    <div className="grid gap-4">
      {state.secret ? (
        <OneTimeSecret
          label="Signing secret"
          value={state.secret}
          note="Copy the signing secret now. You will not see it again. Rotate it to get a new one."
        />
      ) : null}
      <form action={action} className="grid gap-4" noValidate>
        <input type="hidden" name="company_id" value={companyId} />
        <div className="grid gap-1.5">
          <label htmlFor="webhook-url" className={LABEL}>
            Endpoint URL
          </label>
          <input
            id="webhook-url"
            name="url"
            type="url"
            inputMode="url"
            autoCapitalize="none"
            spellCheck={false}
            maxLength={500}
            placeholder="https://acme.io/hooks/nextcryptojob"
            defaultValue={state.url ?? url ?? ""}
            aria-invalid={state.errors?.url ? true : undefined}
            aria-describedby={state.errors?.url ? "webhook-url-error webhook-url-hint" : "webhook-url-hint"}
            className={FIELD}
            disabled={locked}
          />
          <p id="webhook-url-hint" className={HINT}>
            https only, a public host name on port 443. We do not follow redirects.
          </p>
          {state.errors?.url ? (
            <p id="webhook-url-error" role="alert" className={ERROR}>
              {state.errors.url}
            </p>
          ) : null}
        </div>
        <label className="flex min-h-11 items-center gap-3 text-sm text-ink">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={url ? enabled : true}
            disabled={locked}
            className="size-5 accent-brand"
          />
          Enabled
        </label>
        <div className="flex flex-wrap gap-2">
          <SubmitButton name="intent" value="save" className="h-11 px-4" pendingLabel="Saving..." disabled={locked}>
            Save
          </SubmitButton>
          <SubmitButton name="intent" value="test" variant="outline" className="h-11 px-4" pendingLabel="Sending..." disabled={locked || !url}>
            Send test
          </SubmitButton>
          <SubmitButton name="intent" value="rotate" variant="outline" className="h-11 px-4" pendingLabel="Rotating..." disabled={locked || !url}>
            Rotate secret
          </SubmitButton>
        </div>
        <FormMessageLine message={state.message} />
      </form>
    </div>
  );
}
