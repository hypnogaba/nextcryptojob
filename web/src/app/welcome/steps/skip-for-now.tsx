import { SubmitButton } from "@/components/form/submit-button";

/** Текст під «Skip for now»: крок не обов'язковий, добірка працює без нього. */
export const SKIP_NOTE = "Optional. Your daily jobs keep coming without it, and you can add it later from your profile.";

/**
 * «Skip for now» для кроків «Stand out»: переходить далі, нічого не зберігаючи й не прибираючи.
 * Добірці не потрібні ні X, ні гаманці, ні інші джерела (engine/src/digest/schedule.ts).
 */
export function SkipForNow({ action, note = SKIP_NOTE }: { action: () => Promise<void>; note?: string }) {
  return (
    <form action={action} className="grid gap-2 border-t border-line pt-6">
      <p className="text-sm text-ink-muted">{note}</p>
      <SubmitButton variant="outline" pendingLabel="Skipping..." className="h-11 text-base">
        Skip for now
      </SubmitButton>
    </form>
  );
}
