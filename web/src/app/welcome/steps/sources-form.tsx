"use client";

import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR, FIELD, HINT, LABEL } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { saveSourcesAction } from "../actions/sources";
import type { StepState } from "../flow";

type Key = "github" | "youtube" | "site";

const FIELDS: { key: Key; label: string; placeholder: string; hint: string; inputMode?: "url" }[] = [
  {
    key: "github",
    label: "GitHub",
    placeholder: "yourlogin",
    hint: "Login or profile link. The main source for Engineer, Security auditor and DevRel scores.",
  },
  {
    key: "youtube",
    label: "YouTube",
    placeholder: "@yourchannel",
    hint: "@handle or channel link. Counts for Creator and Marketing scores.",
  },
  {
    key: "site",
    label: "Website or blog",
    placeholder: "https://yoursite.com",
    hint: "Your own site or blog. We read its public posts and feed. Adds to every score.",
    inputMode: "url",
  },
];

export function SourcesForm({ initial, editing }: { initial: Record<Key, string>; editing: boolean }) {
  const [state, action] = useActionState(saveSourcesAction, {} as StepState);
  return (
    <form action={action} className="grid gap-6">
      {FIELDS.map((f) => {
        const error = state.errors?.[f.key];
        return (
          <div key={f.key} className="grid gap-2">
            <label htmlFor={f.key} className={LABEL}>
              {f.label} <span className="font-normal text-ink-muted">(optional)</span>
            </label>
            <input
              id={f.key}
              name={f.key}
              type="text"
              inputMode={f.inputMode}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              defaultValue={state.values?.[f.key] ?? initial[f.key]}
              placeholder={f.placeholder}
              aria-invalid={error ? true : undefined}
              aria-describedby={`${f.key}-hint`}
              className={FIELD}
            />
            <p id={`${f.key}-hint`} className={HINT}>
              {f.hint}
            </p>
            {error ? (
              <p role="alert" className={ERROR}>
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
      <FormMessageLine message={state.message} />
      <SubmitButton pendingLabel="Saving..." className="h-11 text-base">
        {editing ? "Save" : "Save and continue"}
      </SubmitButton>
    </form>
  );
}
