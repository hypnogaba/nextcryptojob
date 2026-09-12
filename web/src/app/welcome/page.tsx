import type { Metadata } from "next";
import { requireUser } from "@/lib/auth/session";
import { hasConsent, SCORING_CONSENT } from "@/lib/consent";
import { db } from "@/lib/db";
import { listIdentities, type Identity } from "@/lib/identity/store";
import { whereFromMode } from "@/lib/onboarding/place";
import { loadAnswers } from "@/lib/onboarding/store";
import { stepToShow } from "@/lib/onboarding/steps";
import { suggestRoles } from "@/lib/roles/suggest";
import { StepShell } from "./step-shell";
import { ConsentForm } from "./steps/consent-form";
import { GithubVerify } from "./steps/github-verify";
import { PlaceForm } from "./steps/place-form";
import { RolesForm } from "./steps/roles-form";
import { SourcesForm } from "./steps/sources-form";
import { TargetForm } from "./steps/target-form";
import { WalletsForm } from "./steps/wallets-form";
import { XStep } from "./steps/x-step";

export const metadata: Metadata = { title: "Set up your profile", robots: { index: false } };

type Props = { searchParams: Promise<{ step?: string | string[]; added?: string | string[] }> };

/**
 * Анкета першого входу. Досягнутий крок у users.onboarding_step: після
 * перезавантаження людина продовжує звідти ж. ?step= відкриває пройдений
 * крок (Back, «Edit sources» з профілю); далі досягнутого не пускає.
 */
export default async function WelcomePage({ searchParams }: Props) {
  const user = await requireUser();
  const sp = await searchParams;
  const d = db();
  const [answers, identities] = await Promise.all([loadAnswers(d, user.id), listIdentities(d, user.id)]);
  const step = stepToShow(sp.step, answers.step);
  const editing = answers.step === "done";
  const one = (kind: Identity["kind"]) => identities.find((i) => i.kind === kind) ?? null;

  switch (step) {
    case "target":
      return (
        <StepShell
          step={step}
          editing={editing}
          lead="Describe the job you want next. A sentence is enough."
        >
          <TargetForm initial={answers.targetText} />
        </StepShell>
      );

    case "roles": {
      const suggested = suggestRoles(answers.targetText);
      return (
        <StepShell
          step={step}
          editing={editing}
          lead={
            suggested.length > 0
              ? "We picked these from your answer. Change them if they are not right. Choose up to 3."
              : "We could not match a role from your words. Choose up to 3."
          }
        >
          <RolesForm initial={answers.roles.length > 0 ? answers.roles : suggested} suggested={suggested} />
        </StepShell>
      );
    }

    case "place":
      return (
        <StepShell step={step} editing={editing} lead="We use this to pick jobs for you. It does not change your score.">
          <PlaceForm
            initial={{
              where: whereFromMode(answers.remoteMode),
              city: answers.city ?? "",
              salary: answers.salaryMin ? String(answers.salaryMin) : "",
              currency: answers.salaryCurrency ?? "USD",
            }}
          />
        </StepShell>
      );

    case "x":
      return (
        <StepShell
          step={step}
          editing={editing}
          lead="We read your public profile and posts to score you. First we check the account is yours."
        >
          <XStep identity={one("x")} editing={editing} />
        </StepShell>
      );

    case "wallets":
      return (
        <StepShell
          step={step}
          editing={editing}
          lead="Wallets show onchain experience and trading. They matter most for Trader."
        >
          <WalletsForm
            editing={editing}
            initial={identities
              .filter((i) => i.kind === "evm" || i.kind === "solana")
              .map((i) => i.value)
              .join("\n")}
          />
        </StepShell>
      );

    case "sources": {
      const github = one("github");
      const justAdded = sp.added === "github";
      return (
        <StepShell step={step} editing={editing} lead="Each one is optional. Add what shows your work.">
          <div className="grid gap-10">
            {github ? <GithubVerify identity={github} justAdded={justAdded} /> : null}
            <SourcesForm
              editing={editing}
              initial={{
                github: github?.value ?? "",
                youtube: one("youtube")?.value ?? "",
                site: one("site")?.value ?? "",
                sherlock: one("sherlock")?.value ?? "",
              }}
            />
          </div>
        </StepShell>
      );
    }

    case "consent": {
      const granted = await hasConsent(d, user.id, SCORING_CONSENT.kind);
      return (
        <StepShell
          step={step}
          editing={editing}
          lead="We compute a score only with your consent."
        >
          <ConsentForm granted={granted} />
        </StepShell>
      );
    }
  }
}
