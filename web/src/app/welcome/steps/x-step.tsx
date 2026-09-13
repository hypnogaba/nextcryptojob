import { SubmitButton } from "@/components/form/submit-button";
import type { Identity } from "@/lib/identity/store";
import { continueXAction, resetXAction } from "../actions/x";
import { ClaimXForm } from "./claim-x-form";
import { SkipForNow } from "./skip-for-now";
import { VerifiedBadge } from "./verified-badge";
import { VerifyPanel } from "./verify-panel";

const WHY_X =
  "Optional. Your daily jobs keep coming without it. X helps companies find you: BD, community, product, marketing and creator scores need it.";

/** Крок X у трьох станах: немає ніка → є нік і код → підтверджено. */
export function XStep({ identity, editing }: { identity: Identity | null; editing: boolean }) {
  const continueLabel = editing ? "Save" : "Continue";

  if (!identity) {
    return (
      <div className="grid gap-8">
        <ClaimXForm />
        {editing ? null : <SkipForNow action={continueXAction} note={WHY_X} />}
      </div>
    );
  }

  const change = (
    <form action={resetXAction}>
      <SubmitButton variant="link" pendingLabel="Removing..." className="h-11 px-0">
        Use a different handle
      </SubmitButton>
    </form>
  );

  if (identity.verifiedAt) {
    return (
      <div className="grid gap-6">
        <VerifiedBadge label={`@${identity.value}`} />
        <p className="text-sm text-ink-muted">You can remove the code from your bio or delete the post now.</p>
        <form action={continueXAction}>
          <SubmitButton pendingLabel="Saving..." className="h-11 w-full text-base">
            {continueLabel}
          </SubmitButton>
        </form>
        {change}
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      <p className="text-ink">
        Linking <span className="font-medium">@{identity.value}</span>
      </p>
      <VerifyPanel kind="x" code={identity.verifyCode ?? ""}>
        Add this code to your X bio or post it, then press Check. You can remove it after.
      </VerifyPanel>
      <div className="grid gap-2">
        {change}
        {editing ? null : <SkipForNow action={continueXAction} note={`${WHY_X} Until you check the code, we do not use this account.`} />}
      </div>
    </div>
  );
}
