"use client";

import Link from "next/link";
import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { SubmitButton } from "@/components/form/submit-button";
import { SwitchButton } from "@/components/form/switch-button";
import { cn } from "@/lib/utils";
import { setVisibilityAction, type SettingsState } from "./actions";

// Те, що віддає lib/crm/project.ts: ролі й бали, мережі й роки ончейн, які джерела підключено, де й за скільки.
const SEE = [
  "Your roles, scores and levels",
  "Which chains you use and for how long",
  "Which sources you connected, not the accounts",
  "Remote or a city, and the pay you want",
];
const NEVER = ["Your wallet addresses", "Your email", "Your X, GitHub or YouTube accounts"];

/**
 * «Show me to companies» окремою панеллю з власним тлом (власник 14.09: натиснув і не побачив
 * змін). Стан словами великим рядком, тло панелі міняється разом зі станом, під ним що компанії
 * бачать і чого ніколи, і рядок «Saved» після натискання.
 */
export function VisibilityForm({ visible, canTurnOn }: { visible: boolean; canTurnOn: boolean }) {
  const [state, action] = useActionState(setVisibilityAction, {} as SettingsState);
  const locked = !visible && !canTurnOn;
  return (
    <section
      aria-labelledby="companies-title"
      data-visible={visible ? "on" : "off"}
      className={cn(
        "grid gap-5 rounded-xl border-2 p-4 transition-colors sm:p-6",
        visible ? "border-brand bg-brand-soft" : "border-ink bg-wash",
      )}
    >
      <div className="grid gap-1">
        <h2 id="companies-title" className="display text-[1.75rem] leading-none">
          Show me to companies
        </h2>
        <p className="text-sm text-ink-muted">
          Companies that pay for NextCryptoJob search for candidates by role and score. This decides if you are in
          that search.
        </p>
      </div>

      <form action={action} className="grid gap-4">
        {/* Кнопка шле протилежне до поточного: одне натискання = одна зміна. */}
        <input type="hidden" name="visible" value={visible ? "off" : "on"} />
        <div className="flex items-center justify-between gap-4 rounded-xl border border-line bg-surface p-3 sm:p-4">
          <div className="grid gap-0.5">
            <p id="visibility-label" className="flex items-start gap-2 text-lg leading-snug font-semibold text-ink">
              <span aria-hidden className={cn("mt-2 inline-block size-3 shrink-0 rounded-full", visible ? "bg-brand" : "bg-line-strong")} />
              {visible ? "You are visible to companies" : "You are hidden from companies"}
            </p>
            <p id="visibility-help" className="text-sm text-ink-muted">
              {visible
                ? "Companies with access can find you in their search. Turn it off and you leave their search at once."
                : "No company can find you. Your score and daily jobs work the same either way."}
            </p>
          </div>
          <SwitchButton
            checked={visible}
            disabled={locked}
            labelledBy="visibility-label"
            describedBy="visibility-help visibility-see"
          />
        </div>

        <div id="visibility-see" className="grid gap-4 text-sm sm:grid-cols-2">
          <div className="grid gap-1.5">
            <p className="font-semibold text-ink">When you are visible, companies see</p>
            <ul className="grid gap-1 text-ink">
              {SEE.map((t) => (
                <li key={t}>+ {t}</li>
              ))}
            </ul>
          </div>
          <div className="grid gap-1.5">
            <p className="font-semibold text-ink">They never see</p>
            <ul className="grid gap-1 text-ink">
              {NEVER.map((t) => (
                <li key={t}>&minus; {t}</li>
              ))}
            </ul>
          </div>
        </div>
        <p className="text-sm text-ink-muted">
          How a company can reach you is your choice, in the next section.
        </p>

        {locked ? (
          <p className="text-sm text-ink">
            You need a score first.{" "}
            <Link href="/welcome" className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
              Finish setting up
            </Link>
          </p>
        ) : (
          <SubmitButton
            variant={visible ? "outline" : "default"}
            pendingLabel="Saving..."
            className="h-11 w-full px-5 text-base sm:w-fit"
          >
            {visible ? "Hide me from companies" : "Show me to companies"}
          </SubmitButton>
        )}
        <FormMessageLine message={state.message} />
      </form>
    </section>
  );
}
