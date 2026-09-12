import { SubmitButton } from "@/components/form/submit-button";
import type { Identity } from "@/lib/identity/store";
import { continueSourcesAction } from "../actions/sources";
import { VerifiedBadge } from "./verified-badge";
import { VerifyPanel } from "./verify-panel";

/**
 * Підтвердження GitHub кодом у біо (необов'язково). Рушій довіряє профілю
 * Sherlock лише через підтверджений GitHub або X, тож це варто зробити аудиторам.
 */
export function GithubVerify({ identity, justAdded }: { identity: Identity; justAdded: boolean }) {
  if (identity.verifiedAt) return <VerifiedBadge label={`github.com/${identity.value}`} />;
  return (
    <section aria-labelledby="gh-verify" className="grid gap-3">
      <h2 id="gh-verify" className="font-sans text-base font-semibold text-ink">
        Verify your GitHub <span className="font-normal text-ink-muted">(optional)</span>
      </h2>
      <p className="text-sm text-ink-muted">
        A verified GitHub shows companies the account is yours, and lets us link your Sherlock audits.
      </p>
      <VerifyPanel kind="github" code={identity.verifyCode ?? ""}>
        Add this code to the bio of <span className="font-medium text-ink">github.com/{identity.value}</span> in your
        GitHub profile settings, then press Check. You can remove it after.
      </VerifyPanel>
      {justAdded ? (
        <form action={continueSourcesAction}>
          <SubmitButton variant="outline" pendingLabel="Saving..." className="h-11 w-full text-base">
            Verify later and continue
          </SubmitButton>
        </form>
      ) : null}
    </section>
  );
}
