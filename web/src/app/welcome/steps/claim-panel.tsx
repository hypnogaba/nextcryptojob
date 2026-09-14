import Link from "next/link";
import { VerifyPanel } from "./verify-panel";

/**
 * Нік тримає інший профіль без підтвердження. Людина доводить, що нік її,
 * власним кодом заявки, і тоді нік переходить до неї вже перевіреним. Після 13.09
 * (модель довіри) це єдине місце, де ще є код: спір за чужий нік.
 */
export function ClaimPanel({
  kind,
  value,
  code,
  backHref,
}: {
  kind: "x" | "github";
  value: string;
  code: string;
  backHref: string;
}) {
  const shown = kind === "x" ? `@${value}` : `github.com/${value}`;
  const name = kind === "x" ? "X" : "GitHub";
  return (
    <section aria-labelledby={`claim-${kind}`} className="grid gap-3">
      <h2 id={`claim-${kind}`} className="font-sans text-base font-semibold text-ink">
        Is {shown} yours?
      </h2>
      <p className="text-sm text-ink-muted">
        Another profile already added this {name} account. We usually take people at their word, so if it is yours,
        prove it once with the code below and it moves to your profile.
      </p>
      <VerifyPanel kind={kind} code={code} claim={value}>
        {kind === "x"
          ? "Add this code to your X bio or post it, then press Check. You can remove it after."
          : "Add this code to your GitHub bio in your profile settings, then press Check. You can remove it after."}
      </VerifyPanel>
      <Link href={backHref} className="inline-flex min-h-11 items-center text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
        Use a different {kind === "x" ? "handle" : "login"}
      </Link>
    </section>
  );
}
