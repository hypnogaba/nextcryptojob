import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { AccountShell } from "@/components/account-nav";
import { SignOutButton } from "@/components/sign-out-button";
import { Button } from "@/components/ui/button";
import { HINT } from "@/components/form/styles";
import { loadSettings } from "@/lib/account/settings";
import { timezoneList } from "@/lib/account/timezones";
import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { AddEmailForm } from "../account/add-email-form";
import { TelegramPanel } from "../account/telegram-panel";
import { DailyJobsForm } from "./daily-jobs-form";
import { DeleteAccountForm } from "./delete-form";
import { VisibilityForm } from "./visibility-form";

export const metadata: Metadata = { title: "Settings", robots: { index: false } };

function Section({ id, title, intro, children }: { id: string; title: string; intro?: string; children: ReactNode }) {
  return (
    <section aria-labelledby={`${id}-title`} className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:p-6">
      <div className="grid gap-1">
        <h2 id={`${id}-title`} className="display text-[1.75rem] leading-none">
          {title}
        </h2>
        {intro ? <p className={HINT}>{intro}</p> : null}
      </div>
      {children}
    </section>
  );
}

/** Налаштування, round4 (макет design-round4/dir-6): Sign-in, Daily jobs, Privacy, Your data,
 * вихід, у бічному меню кабінету (AccountShell). Кожна група та сама поведінка й ті самі
 * server actions, що й раніше; лише розкладка й навігація нові (власник 15.09, п.7). */
export default async function SettingsPage() {
  const user = await requireUser();
  const s = await loadSettings(db(), user.id);
  if (!s) redirect("/login");

  return (
    <AccountShell active="settings" title="Settings" sub="How we reach you and who can see you.">
      <div className="grid gap-6">
      <Section id="signin" title="Sign-in" intro="Email and Telegram: how you sign in, and where daily jobs can go.">
        <div className="grid gap-1">
          <span className="text-sm font-semibold text-ink-muted">Email</span>
          <span className="text-ink">{user.email ?? "Not added yet"}</span>
        </div>
        {user.email ? null : (
          <div className="border-t border-line pt-4">
            <AddEmailForm intro="We send a code to check it's yours. Then daily jobs can go there, and you can sign in with it." />
          </div>
        )}
        <div className="border-t border-line pt-4">
          <TelegramPanel userId={user.id} />
        </div>
      </Section>

      <Section id="daily" title="Daily jobs" intro="Up to 5 jobs that match your roles, once a day at the hour you choose.">
        {s.email ? null : (
          <div className="border-b border-line pb-4">
            <AddEmailForm intro="To get daily jobs by email, add an email first. We send a code to check it's yours." />
          </div>
        )}
        <DailyJobsForm
          email={s.email}
          telegramLinked={s.telegramLinked}
          channel={s.channel}
          hour={s.digestHour}
          timezone={s.timezone}
          paused={s.digestPaused}
          zones={timezoneList()}
        />
        <p className={`${HINT} border-t border-line pt-4`}>
          <Link href="/jobs" className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
            See the jobs we sent you
          </Link>{" "}
          in the last 14 days.
        </p>
      </Section>

      <VisibilityForm
        visible={s.visible}
        canTurnOn={s.scoringConsent}
        contact={{ mode: s.contactMode, telegramHandle: s.telegramHandle }}
      />

      <Section id="data" title="Your data">
        <div className="grid gap-3">
          <p className={HINT}>
            A JSON file with your account, sources, collected data, scores, cards and consent history.
          </p>
          <Button asChild size="lg" variant="outline" className="w-full sm:w-fit">
            <a href="/api/me/export" download>
              Download my data
            </a>
          </Button>
        </div>
        <div className="grid gap-3 border-t border-line pt-4">
          <h3 className="font-sans text-base font-semibold">Delete my account</h3>
          <DeleteAccountForm />
        </div>
      </Section>

      <p className={HINT}>
        There are no boxes to tick here either: using NextCryptoJob, including changing a setting on this page, means
        you accept the{" "}
        <Link href="/terms" className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
          Terms
        </Link>{" "}
        and the{" "}
        <Link href="/privacy" className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
          Privacy Policy
        </Link>
        . Read{" "}
        <Link href="/how-scoring-works" className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
          how scoring works
        </Link>
        .
      </p>

      <div>
        <SignOutButton />
      </div>
      </div>
    </AccountShell>
  );
}
