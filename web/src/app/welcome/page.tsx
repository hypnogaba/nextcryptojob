import type { Metadata } from "next";
import { cookies } from "next/headers";
import Link from "next/link";
import type { ReactNode } from "react";
import { AccountShell } from "@/components/account-nav";
import { isAdminSession } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/session";
import { appEnv, db } from "@/lib/db";
import { loadSettings } from "@/lib/account/settings";
import { timezoneList } from "@/lib/account/timezones";
import { listIdentities, type Identity } from "@/lib/identity/store";
import { MAX_WALLETS } from "@/lib/identity/wallets";
import { placeFromText, whereFromMode } from "@/lib/onboarding/place";
import { BRIEF_COOKIE, readBriefCookie } from "@/lib/onboarding/brief-cookie";
import { loadAnswers } from "@/lib/onboarding/store";
import { briefDone, isBriefStep, stepToShow, type Step } from "@/lib/onboarding/steps";
import { guessRoles } from "@/lib/roles/infer";
import { AddEmailForm } from "../account/add-email-form";
import { DailyJobsForm } from "../settings/daily-jobs-form";
import { saveDeliveryAction } from "./actions/delivery";
import { continueSourcesAction } from "./actions/sources";
import { parseWait } from "./flow";
import { StepShell } from "./step-shell";
import { PlaceForm } from "./steps/place-form";
import { RolesForm } from "./steps/roles-form";
import { SkipForNow } from "./steps/skip-for-now";
import { SourcesForm } from "./steps/sources-form";
import { TargetForm } from "./steps/target-form";
import { WalletsForm } from "./steps/wallets-form";
import { XForm } from "./steps/x-form";

export const metadata: Metadata = { title: "Set up your profile", robots: { index: false } };

type Param = string | string[] | undefined;
type Props = { searchParams: Promise<{ step?: Param; wait?: Param }> };

const LINK = "font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand";

/**
 * Анкета першого входу. Досягнутий крок у users.onboarding_step: після
 * перезавантаження людина продовжує звідти ж. ?step= відкриває пройдений
 * крок (Back, «Edit» з профілю чи /jobs); далі досягнутого не пускає.
 * Спершу анкета (4 кроки; остання кнопка приймає умови рядком під нею, без галок), далі кроки
 * балу: X обов'язковий, гаманці й джерела необов'язкові; після них /welcome/score з балом і карткою.
 */
export default async function WelcomePage({ searchParams }: Props) {
  const user = await requireUser();
  const sp = await searchParams;
  const d = db();
  const [answers, identities] = await Promise.all([loadAnswers(d, user.id), listIdentities(d, user.id)]);
  let step = stepToShow(sp.step, answers.step);
  // X обов'язковий: хто дійшов до гаманців чи джерел без X (старий порядок, де X можна було
  // пропустити), спершу вписує X. Після завершення анкети кроки відкриваються як правка.
  if ((step === "wallets" || step === "sources") && answers.step !== "done" && !identities.some((i) => i.kind === "x")) {
    step = "x";
  }
  // Анкету правують після умов; кроки «Stand out» лише тоді, коли пройдено й їх.
  const editing = isBriefStep(step) ? briefDone(answers.step) : answers.step === "done";
  const one = (kind: Identity["kind"]) => identities.find((i) => i.kind === kind) ?? null;
  const wait = parseWait(sp.wait);
  const notice = wait ? `Saved. You can update your score in ${wait} seconds, from your profile.` : null;
  // Адмін, що ввійшов поштою, анкету проходити не мусить (власник 14.09).
  const admin = !briefDone(answers.step) && isAdminSession(user, (appEnv() as { ADMIN_EMAILS?: string }).ADMIN_EMAILS);
  const shell = (s: Step, lead: ReactNode, children: ReactNode) => {
    const stepShell = (
      <StepShell
        step={s}
        editing={editing}
        lead={lead}
        notice={notice}
        banner={
          admin ? (
            <p className="rounded-xl border border-line bg-wash px-3 py-2 text-sm text-ink">
              You are signed in as an admin. This setup is optional for you.{" "}
              <Link href="/admin" className={LINK}>
                Go to admin
              </Link>
            </p>
          ) : null
        }
      >
        {children}
      </StepShell>
    );
    // Раунд 5, п.10: правка відповідей (editing) лишається в кабінеті, з бічним меню на місці.
    // Заголовок тут не задаємо: StepShell уже показує свій («Step N of M», назва кроку).
    return editing ? (
      <AccountShell active="answers">{stepShell}</AccountShell>
    ) : (
      stepShell
    );
  };

  switch (step) {
    case "target":
      return shell(
        step,
        "Tell us about the job you want next, the way you would tell a friend. The more you say, the better we match jobs for you.",
        // Порожній бриф бере чернетку з головної (кука з /start).
        <TargetForm initial={answers.targetText || readBriefCookie((await cookies()).get(BRIEF_COOKIE)?.value)} />,
      );

    case "roles": {
      // Певні ролі зі слів, а якщо певних немає, три найближчі (власник 14.09: «треба щось запропонувати»).
      const guess = guessRoles(answers.targetText);
      return shell(
        step,
        "We read your role from what you wrote. Check it and fix it if we got it wrong.",
        <RolesForm
          initial={answers.roles.length > 0 ? answers.roles : guess.roles}
          inferred={guess.roles}
          closest={!guess.confident}
          roleText={answers.roleText}
        />,
      );
    }

    case "place": {
      // Ще не збережено: беремо «remote» і зарплату з першого кроку, людина бачить і править.
      const fresh = answers.remoteMode === null && answers.salaryMin === null;
      const guess = fresh ? placeFromText(answers.targetText) : null;
      const guessed = guess !== null && (guess.where !== null || guess.salary !== null);
      return shell(
        step,
        guessed
          ? "We filled this in from your words. Change it if it is not right. It picks your jobs and does not change your score."
          : "We use this to pick jobs for you. It does not change your score.",
        <PlaceForm
          initial={{
            where: whereFromMode(answers.remoteMode) ?? guess?.where ?? null,
            city: answers.city ?? "",
            salary: answers.salaryMin ? String(answers.salaryMin) : guess?.salary ? String(guess.salary) : "",
            currency: answers.salaryCurrency ?? guess?.currency ?? "USD",
          }}
        />,
      );
    }

    case "delivery": {
      const s = await loadSettings(d, user.id);
      if (!s) return null;
      // Збережений канал, якщо ним можна слати; інакше той, що є (як planChannel в engine).
      const channel =
        s.channel === "telegram" && s.telegramLinked ? "telegram" : s.email ? "email" : s.telegramLinked ? "telegram" : s.channel;
      return shell(
        step,
        "Up to 5 jobs a day that fit your brief, at the hour you pick. You can pause any time.",
        <div className="grid gap-8">
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
            hideUnavailable
            footnote={
              editing ? null : (
                // Власник 14.09, раунд 3: без галок, користування сервісом і є згодою.
                <p className="text-sm text-ink-muted" data-terms-line="">
                  By continuing you agree to the{" "}
                  <Link href="/terms" className={LINK}>
                    Terms
                  </Link>{" "}
                  and{" "}
                  <Link href="/privacy" className={LINK}>
                    Privacy
                  </Link>
                  .
                </p>
              )
            }
          />
          {s.email ? null : (
            // Вхід через Telegram без пошти: Email не показуємо вимкненим, а даємо додати тут же.
            <details className="group grid gap-3 border-t border-line pt-4">
              <summary className="inline-flex min-h-11 cursor-pointer items-center text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
                Want your jobs by email? Add an email
              </summary>
              <div className="mt-2">
                <AddEmailForm intro="We send a 6-digit code to check it is yours. Then Email appears above as an option." />
              </div>
            </details>
          )}
          {s.telegramLinked ? null : (
            <p className="text-sm text-ink-muted">
              Prefer Telegram? You can connect it later on your{" "}
              <Link href="/account" className={LINK}>
                account page
              </Link>
              .
            </p>
          )}
        </div>,
      );
    }

    case "x":
      // Без коду в біо й без перевірки, навіть коли той самий нік уже вписав хтось інший (раунд 3).
      return shell(
        step,
        editing
          ? "We read your public profile and posts to score you."
          : "Required to continue. We read your public profile and posts to score you: followers, known crypto accounts that follow you and reactions to your posts. One X account per profile.",
        <XForm initial={one("x")?.value ?? ""} editing={editing} />,
      );

    case "wallets":
      // Гаманець обов'язковий, як X (власник 15.09, п.5): без «Skip for now», WalletsForm
      // сама не пускає далі без жодної адреси при першому проході (editing=false).
      return shell(
        step,
        editing
          ? `Each wallet raises your score. Add up to ${MAX_WALLETS}: onchain history counts for every role and is the whole Trader score.`
          : `Required to continue, like X. Add at least one address, up to ${MAX_WALLETS}: onchain history counts for every role and is the whole Trader score.`,
        <WalletsForm
          editing={editing}
          initial={identities
            .filter((i) => i.kind === "evm" || i.kind === "solana")
            .map((i) => i.value)
            .join("\n")}
        />,
      );

    case "sources":
      return shell(
        step,
        "Optional, and each one raises your score. Add what shows your work.",
        <div className="grid gap-10">
          <SourcesForm
            editing={editing}
            initial={{
              github: one("github")?.value ?? "",
              youtube: one("youtube")?.value ?? "",
              site: one("site")?.value ?? "",
            }}
          />
          {editing ? null : (
            <SkipForNow action={continueSourcesAction} note="Optional. Next: we score your work and show your card." />
          )}
        </div>,
      );
  }
}
