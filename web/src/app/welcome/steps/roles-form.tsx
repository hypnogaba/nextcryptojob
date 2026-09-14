"use client";

import { useActionState, useState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR, FIELD, HINT, LABEL } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { ROLES, type RoleKey } from "@/lib/card/roles";
import { MAX_ROLES, ROLE_ORDER, UNSCORED } from "@/lib/roles/catalog";
import { ROLE_TEXT_MAX } from "@/lib/onboarding/store";
import { cn } from "@/lib/utils";
import { saveRolesAction } from "../actions/answers";
import type { StepState } from "../flow";

const CHIP =
  "inline-flex min-h-11 items-center gap-2 rounded-full border px-4 text-sm font-semibold transition-colors " +
  "focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none";

/**
 * Крок ролей як підтвердження здогаду: ролі, які ми прочитали з першого кроку, стоять вибраними
 * (прибрати хрестиком), решту можна додати одним натисканням, до трьох. Якщо певної ролі в словах
 * немає, стоять три найближчі (closest), і заголовок каже, що це лише здогад. Якщо роботи людини в
 * списку немає, вона пише її своїми словами: ми шукаємо вакансії з цими словами в назві.
 */
export function RolesForm({
  initial,
  inferred,
  closest = false,
  roleText,
}: {
  /** Вибрані на початку: збережені ролі або здогад зі слів. */
  initial: RoleKey[];
  /** Що ми прочитали з першого кроку (порожньо лише для порожнього тексту). */
  inferred: RoleKey[];
  /** Певної ролі в словах немає: inferred це найближчі ролі, не певні. */
  closest?: boolean;
  roleText: string;
}) {
  const [state, action] = useActionState(saveRolesAction, {} as StepState);
  const [selected, setSelected] = useState<RoleKey[]>(initial);
  const full = selected.length >= MAX_ROLES;
  const remove = (role: RoleKey) => setSelected((cur) => cur.filter((r) => r !== role));
  const add = (role: RoleKey) => setSelected((cur) => (cur.includes(role) || cur.length >= MAX_ROLES ? cur : [...cur, role]));
  // Спершу ті, що ми прочитали, але людина прибрала; далі порядок договору.
  const others = [...inferred, ...ROLE_ORDER.filter((r) => !inferred.includes(r))].filter((r) => !selected.includes(r));
  const notes = selected.filter((r) => UNSCORED[r]);
  const error = state.errors?.role;
  const textError = state.errors?.role_text;

  return (
    <form action={action} className="grid gap-8">
      <section aria-labelledby="picked-h" className="grid gap-3 rounded-xl border border-line bg-surface p-4 sm:p-5">
        <h2 id="picked-h" className="font-sans text-base font-semibold text-ink">
          {inferred.length === 0
            ? "We could not tell your role from your words."
            : closest
              ? "We are not sure of your role. These are the closest to your words:"
              : "We think you are looking for:"}
        </h2>
        {selected.length > 0 ? (
          <ul className="flex flex-wrap gap-2" aria-label="Your roles">
            {selected.map((role) => (
              <li key={role}>
                <input type="hidden" name="role" value={role} />
                <button
                  type="button"
                  onClick={() => remove(role)}
                  aria-label={`Remove ${ROLES[role].name}`}
                  className={cn(CHIP, "border-ink bg-ink text-surface hover:bg-ink/85")}
                >
                  {ROLES[role].name}
                  <span aria-hidden className="text-base leading-none">
                    &times;
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">No role yet. Add the closest one below.</p>
        )}
        <p className={HINT}>
          {selected.length > 0
            ? "Correct? Remove what is wrong or add a role below. We send you jobs for these roles and score you for them."
            : "We send you jobs for the roles you pick and score you for them."}
        </p>
        {notes.map((role) => (
          <p key={role} className="text-sm text-ink">
            {ROLES[role].name}: we send you jobs, but there is no score for it yet. It needs{" "}
            {UNSCORED[role] === "needs_portfolio" ? "a portfolio" : "a CV"}, and that is coming soon.
          </p>
        ))}
      </section>

      <section aria-labelledby="add-h" className="grid gap-3">
        <h2 id="add-h" className={LABEL}>
          Add a role <span className="font-normal text-ink-muted">({selected.length} of {MAX_ROLES})</span>
        </h2>
        <ul className="flex flex-wrap gap-2">
          {others.map((role) => (
            <li key={role}>
              <button
                type="button"
                onClick={() => add(role)}
                disabled={full}
                className={cn(
                  CHIP,
                  "border-line bg-surface text-ink hover:border-ink disabled:cursor-not-allowed disabled:opacity-50",
                )}
              >
                <span aria-hidden className="text-base leading-none text-ink-muted">
                  +
                </span>
                {ROLES[role].name}
              </button>
            </li>
          ))}
        </ul>
        {full ? <p className={HINT}>Up to {MAX_ROLES} roles. Remove one to add another.</p> : null}
      </section>

      <div className="grid gap-2">
        <label htmlFor="role_text" className={LABEL}>
          My role is not in the list <span className="font-normal text-ink-muted">(optional)</span>
        </label>
        <input
          id="role_text"
          name="role_text"
          type="text"
          maxLength={ROLE_TEXT_MAX}
          defaultValue={state.values?.role_text ?? roleText}
          placeholder="For example: Tokenomics designer"
          aria-invalid={textError ? true : undefined}
          aria-describedby="role-text-hint"
          className={FIELD}
        />
        <p id="role-text-hint" className={HINT}>
          Write it in a few words. We also send you jobs whose title has these words. Separate two roles with a comma.
        </p>
        {textError ? (
          <p role="alert" className={ERROR}>
            {textError}
          </p>
        ) : null}
      </div>

      <div className="grid gap-3">
        {error ? (
          <p role="alert" className={ERROR}>
            {error}
          </p>
        ) : null}
        <FormMessageLine message={state.message} />
        <SubmitButton pendingLabel="Saving..." className="h-11 text-base" disabled={selected.length === 0}>
          {selected.length > 0 ? "Yes, continue" : "Pick a role to continue"}
        </SubmitButton>
      </div>
    </form>
  );
}
