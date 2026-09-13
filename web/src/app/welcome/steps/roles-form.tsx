"use client";

import { useActionState, useState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { POSITION_CODE } from "@/lib/roles/recipes";
import { ROLES, type RoleKey } from "@/lib/card/roles";
import { isScoredRole, MAX_ROLES, ROLE_ORDER, unscoredNote } from "@/lib/roles/catalog";
import { cn } from "@/lib/utils";
import { saveRolesAction } from "../actions/answers";
import type { StepState } from "../flow";

function RoleOption({
  role,
  checked,
  disabled,
  suggested,
  onToggle,
}: {
  role: RoleKey;
  checked: boolean;
  disabled: boolean;
  suggested: boolean;
  onToggle: (role: RoleKey) => void;
}) {
  const note = unscoredNote(role);
  return (
    <label
      className={cn(
        "flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border bg-surface px-3 py-3 transition-colors",
        checked ? "border-ink shadow-[inset_0_0_0_1px_var(--ink)]" : "border-line hover:border-line-strong",
        disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <input
        type="checkbox"
        name="role"
        value={role}
        checked={checked}
        disabled={disabled}
        onChange={() => onToggle(role)}
        className="mt-0.5 size-5 shrink-0 accent-[var(--brand)]"
      />
      <span className="grid gap-0.5">
        <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm font-semibold text-ink">
          <span aria-hidden className="font-display text-lg leading-none font-black">
            {POSITION_CODE[role]}
          </span>
          {ROLES[role].name}
          {suggested ? <span className="text-xs font-semibold text-brand">Suggested</span> : null}
        </span>
        {note ? <span className="text-xs text-ink-muted">{note}</span> : null}
      </span>
    </label>
  );
}

export function RolesForm({ initial, suggested }: { initial: RoleKey[]; suggested: RoleKey[] }) {
  const [state, action] = useActionState(saveRolesAction, {} as StepState);
  const [selected, setSelected] = useState<RoleKey[]>(initial);
  const full = selected.length >= MAX_ROLES;

  const toggle = (role: RoleKey) =>
    setSelected((cur) => (cur.includes(role) ? cur.filter((r) => r !== role) : cur.length < MAX_ROLES ? [...cur, role] : cur));

  const group = (roles: RoleKey[]) =>
    roles.map((role) => (
      <RoleOption
        key={role}
        role={role}
        checked={selected.includes(role)}
        disabled={full && !selected.includes(role)}
        suggested={suggested.includes(role)}
        onToggle={toggle}
      />
    ));

  const error = state.errors?.role;
  return (
    <form action={action} className="grid gap-6">
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium text-ink">Scored now</legend>
        <div className="grid gap-2 sm:grid-cols-2">{group(ROLE_ORDER.filter(isScoredRole))}</div>
      </fieldset>
      <fieldset className="grid gap-2">
        <legend className="mb-2 text-sm font-medium text-ink">Score coming soon</legend>
        <div className="grid gap-2 sm:grid-cols-2">{group(ROLE_ORDER.filter((r) => !isScoredRole(r)))}</div>
      </fieldset>
      <div className="grid gap-3">
        <p className="text-sm text-ink-muted" aria-live="polite">
          {selected.length} of {MAX_ROLES} chosen
        </p>
        {error ? (
          <p role="alert" className={ERROR}>
            {error}
          </p>
        ) : null}
        <FormMessageLine message={state.message} />
        <SubmitButton pendingLabel="Saving..." className="h-11 text-base" disabled={selected.length === 0}>
          Continue
        </SubmitButton>
      </div>
    </form>
  );
}
