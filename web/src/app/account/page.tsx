import type { Metadata } from "next";
import Link from "next/link";
import { AdminNav } from "@/components/admin-nav";
import { SignOutButton } from "@/components/sign-out-button";
import { isAdminSession } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/session";
import { appEnv, db } from "@/lib/db";
import { briefDone } from "@/lib/onboarding/steps";
import { loadAnswers } from "@/lib/onboarding/store";
import { AddEmailForm } from "./add-email-form";
import { TelegramPanel } from "./telegram-panel";

const LINK =
  "flex min-h-12 items-center justify-between border-b border-line px-1 text-base font-semibold text-ink transition-colors hover:border-ink";

export const metadata: Metadata = { title: "Account", robots: { index: false } };

// Кабінет: пошта (або «Add email», якщо її ще немає), профіль з балом, анкета, вихід.
export default async function AccountPage() {
  const user = await requireUser();
  const { step } = await loadAnswers(db(), user.id);
  const admin = isAdminSession(user, (appEnv() as { ADMIN_EMAILS?: string }).ADMIN_EMAILS);

  return (
    <section className="mx-auto max-w-5xl px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-14">
      <h1 className="display text-title">Account</h1>
      <dl className="mt-8 grid max-w-md gap-1">
        <dt className="text-sm font-semibold text-ink-muted">Email</dt>
        <dd className="text-ink">{user.email ?? "Not added yet"}</dd>
      </dl>
      {user.email ? null : (
        <div className="mt-4 max-w-md">
          <AddEmailForm intro="We send a code to check it's yours. Then daily jobs can go there, and you can sign in with it." />
        </div>
      )}
      <nav aria-label="Your account" className="mt-8 grid max-w-md border-t border-line">
        <Link href="/profile" className={LINK}>
          Your card and score
          <span aria-hidden className="font-display text-xl text-ink-muted">&rarr;</span>
        </Link>
        <Link href="/jobs" className={LINK}>
          Your jobs
          <span aria-hidden className="font-display text-xl text-ink-muted">&rarr;</span>
        </Link>
        <Link href="/welcome" className={LINK}>
          {step === "done" ? "Edit your answers" : briefDone(step) ? "Finish your score setup" : "Finish your brief"}
          <span aria-hidden className="font-display text-xl text-ink-muted">&rarr;</span>
        </Link>
        <Link href="/settings" className={LINK}>
          Settings
          <span aria-hidden className="font-display text-xl text-ink-muted">&rarr;</span>
        </Link>
        <Link href="/company/start" className={LINK}>
          Hiring? Company account
          <span aria-hidden className="font-display text-xl text-ink-muted">&rarr;</span>
        </Link>
      </nav>
      <TelegramPanel userId={user.id} />
      <div className="mt-8">
        <SignOutButton />
      </div>
      {admin ? <AdminNav className="mt-10" /> : null}
    </section>
  );
}
