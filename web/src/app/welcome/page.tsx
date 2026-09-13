import type { Metadata } from "next";
import type { ReactNode } from "react";
import { requireUser } from "@/lib/auth/session";
import { hasConsent, SCORING_CONSENT } from "@/lib/consent";
import { appEnv, db } from "@/lib/db";
import { loadSettings } from "@/lib/account/settings";
import { timezoneList } from "@/lib/account/timezones";
import { normalizeGithub, normalizeX } from "@/lib/identity/normalize";
import { listIdentities, type Identity } from "@/lib/identity/store";
import { whereFromMode } from "@/lib/onboarding/place";
import { loadAnswers } from "@/lib/onboarding/store";
import { briefDone, isBriefStep, stepToShow, type Step } from "@/lib/onboarding/steps";
import { suggestRoles } from "@/lib/roles/suggest";
import { claimCode, holderOf } from "@/lib/verify/claim";
import { DailyJobsForm } from "../settings/daily-jobs-form";
import { saveDeliveryAction } from "./actions/delivery";
import { continueSourcesAction } from "./actions/sources";
import { skipWalletsAction } from "./actions/wallets";
import { parseWait } from "./flow";
import { StepShell } from "./step-shell";
import { ClaimPanel } from "./steps/claim-panel";
import { ConsentForm } from "./steps/consent-form";
import { GithubVerify } from "./steps/github-verify";
import { PlaceForm } from "./steps/place-form";
import { RolesForm } from "./steps/roles-form";
import { SkipForNow } from "./steps/skip-for-now";
import { SourcesForm } from "./steps/sources-form";
import { TargetForm } from "./steps/target-form";
import { WalletsForm } from "./steps/wallets-form";
import { XStep } from "./steps/x-step";

export const metadata: Metadata = { title: "Set up your profile", robots: { index: false } };

type Param = string | string[] | undefined;
type Props = { searchParams: Promise<{ step?: Param; added?: Param; claim?: Param; wait?: Param }> };

/**
 * Код заявки на нік, який тримає інший профіль без підтвердження, або null
 * (нік вільний, уже свій, підтверджений кимось, хибний, або немає секрету).
 */
async function claimFor(d: D1Database, userId: string, kind: "x" | "github", raw: Param) {
  if (typeof raw !== "string" || !raw) return null;
  const parsed = kind === "x" ? normalizeX(raw) : normalizeGithub(raw);
  const secret = appEnv().SESSION_SECRET;
  if (!parsed.ok || !secret) return null;
  if ((await holderOf(d, userId, kind, parsed.value)) !== "pending") return null;
  return { value: parsed.value, code: await claimCode(secret, kind, parsed.value, userId) };
}

/**
 * Анкета першого входу. Досягнутий крок у users.onboarding_step: після
 * перезавантаження людина продовжує звідти ж. ?step= відкриває пройдений
 * крок (Back, «Edit» з профілю чи /jobs); далі досягнутого не пускає.
 * Спершу анкета (5 кроків), після неї /jobs, далі необов'язкове «Stand out».
 */
export default async function WelcomePage({ searchParams }: Props) {
  const user = await requireUser();
  const sp = await searchParams;
  const d = db();
  const [answers, identities] = await Promise.all([loadAnswers(d, user.id), listIdentities(d, user.id)]);
  const step = stepToShow(sp.step, answers.step);
  // Анкету правують після згоди; кроки «Stand out» лише тоді, коли пройдено й їх.
  const editing = isBriefStep(step) ? briefDone(answers.step) : answers.step === "done";
  const one = (kind: Identity["kind"]) => identities.find((i) => i.kind === kind) ?? null;
  const wait = parseWait(sp.wait);
  const notice = wait ? `Saved. You can update your score in ${wait} seconds, from your profile.` : null;
  const shell = (s: Step, lead: ReactNode, children: ReactNode) => (
    <StepShell step={s} editing={editing} lead={lead} notice={notice}>
      {children}
    </StepShell>
  );

  switch (step) {
    case "target":
      return shell(step, "Describe the job you want next. A sentence is enough.", <TargetForm initial={answers.targetText} />);

    case "roles": {
      const suggested = suggestRoles(answers.targetText);
      return shell(
        step,
        suggested.length > 0
          ? "We picked these from your answer. Change them if they are not right. Choose up to 3."
          : "We could not match a role from your words. Choose up to 3.",
        <RolesForm initial={answers.roles.length > 0 ? answers.roles : suggested} suggested={suggested} />,
      );
    }

    case "place":
      return shell(
        step,
        "We use this to pick jobs for you. It does not change your score.",
        <PlaceForm
          initial={{
            where: whereFromMode(answers.remoteMode),
            city: answers.city ?? "",
            salary: answers.salaryMin ? String(answers.salaryMin) : "",
            currency: answers.salaryCurrency ?? "USD",
          }}
        />,
      );

    case "delivery": {
      const s = await loadSettings(d, user.id);
      if (!s) return null;
      // Збережений канал, якщо ним можна слати; інакше той, що є (як planChannel в engine).
      const channel =
        s.channel === "telegram" && s.telegramLinked ? "telegram" : s.email ? "email" : s.telegramLinked ? "telegram" : s.channel;
      return shell(
        step,
        "Up to 5 jobs a day that fit your brief, at the hour you pick. You can pause any time.",
        <DailyJobsForm
          email={s.email}
          telegramLinked={s.telegramLinked}
          channel={channel}
          hour={s.digestHour}
          timezone={s.timezone}
          paused={s.digestPaused}
          zones={timezoneList()}
          action={saveDeliveryAction}
          showPause={false}
          submitLabel={editing ? "Save" : "Continue"}
        />,
      );
    }

    case "x": {
      const claim = await claimFor(d, user.id, "x", sp.claim);
      return shell(
        step,
        "We read your public profile and posts to score you. First we check the account is yours.",
        claim ? (
          <ClaimPanel kind="x" value={claim.value} code={claim.code} backHref="/welcome?step=x" />
        ) : (
          <XStep identity={one("x")} editing={editing} />
        ),
      );
    }

    case "wallets":
      return shell(
        step,
        "Wallets show onchain experience and trading. They matter most for Trader.",
        <div className="grid gap-8">
          <WalletsForm
            editing={editing}
            initial={identities
              .filter((i) => i.kind === "evm" || i.kind === "solana")
              .map((i) => i.value)
              .join("\n")}
          />
          {editing ? null : <SkipForNow action={skipWalletsAction} />}
        </div>,
      );

    case "sources": {
      const github = one("github");
      const claim = await claimFor(d, user.id, "github", sp.claim);
      return shell(
        step,
        "Each one is optional. Add what shows your work.",
        <div className="grid gap-10">
          {claim ? (
            <ClaimPanel kind="github" value={claim.value} code={claim.code} backHref="/welcome?step=sources" />
          ) : github ? (
            <GithubVerify identity={github} justAdded={sp.added === "github"} />
          ) : null}
          <SourcesForm
            editing={editing}
            initial={{
              github: github?.value ?? "",
              youtube: one("youtube")?.value ?? "",
              site: one("site")?.value ?? "",
              sherlock: one("sherlock")?.value ?? "",
            }}
          />
          {editing ? null : (
            <SkipForNow action={continueSourcesAction} note="Optional. Your daily jobs keep coming without these. Next: your score and card." />
          )}
        </div>,
      );
    }

    case "consent": {
      const granted = await hasConsent(d, user.id, SCORING_CONSENT.kind);
      return shell(
        step,
        "We compute a score only with your consent. Next you see the jobs that fit your brief.",
        <ConsentForm granted={granted} editing={editing} />,
      );
    }
  }
}
