"use client";

import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { FIELD, HINT, LABEL } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { DISPLAY_NAME_MAX } from "@/lib/card/display-name";
import type { RoleKey } from "@/lib/card/roles";
import { createCardAction, type ProfileActionState } from "./actions";

/** Ім'я на картці (можна змінити) і «Create my card». */
export function CreateCardForm({ role, defaultName }: { role: RoleKey; defaultName: string }) {
  const [state, action] = useActionState(createCardAction, {} as ProfileActionState);
  const id = `card-name-${role}`;
  return (
    <form action={action} className="grid gap-2 border-t border-line pt-4">
      <input type="hidden" name="role" value={role} />
      <label htmlFor={id} className={LABEL}>
        Name on your card
      </label>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={id}
          name="name"
          type="text"
          required
          maxLength={DISPLAY_NAME_MAX}
          autoComplete="nickname"
          defaultValue={state.name ?? defaultName}
          aria-describedby={`${id}-hint`}
          className={`${FIELD} sm:flex-1`}
        />
        <SubmitButton pendingLabel="Creating..." className="h-11 shrink-0 px-5 text-base">
          Create my card
        </SubmitButton>
      </div>
      <p id={`${id}-hint`} className={HINT}>
        The card is public at its own link. It shows this name, the role, the score, how it was built and the facts behind it as numbers. Never your wallets, links or contacts.
      </p>
      <FormMessageLine message={state.message} />
    </form>
  );
}
