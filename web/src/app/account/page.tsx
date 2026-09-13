import type { Metadata } from "next";
import Link from "next/link";
import { AdminNav } from "@/components/admin-nav";
import { SignOutButton } from "@/components/sign-out-button";
import { isAdminSession } from "@/lib/auth/admin";
import { requireUser } from "@/lib/auth/session";
import { appEnv, db } from "@/lib/db";
import { loadAnswers } from "@/lib/onboarding/store";
import { AddEmailForm } from "./add-email-form";
import { TelegramPanel } from "./telegram-panel";

const LINK =
  "flex min-h-12 items-center justify-between rounded-lg border border-line bg-surface px-4 text-base font-medium text-ink hover:border-line-strong";

export const metadata: Metadata = { title: "Account", robots: { index: false } };

// Кабінет: пошта (або «Add email», якщо її ще немає), профіль з балом, анкета, вихід.
export default async function AccountPage() {
  const user = await requireUser();
  const { step } = await loadAnswers(db(), user.id);
  const admin = isAdminSession(user, (appEnv() as { ADMIN_EMAILS?: string }).ADMIN_EMAILS);

  return (
    <section className="mx-auto max-w-5xl px-4 py-16 sm:px-6 sm:py-24">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Account</h1>
      <dl className="mt-8 grid max-w-md gap-1">
        <dt className="font-mono text-xs tracking-widest text-ink-muted uppercase">Email</dt>
        <dd className="text-ink">{user.email ?? "Not added yet"}</dd>
      </dl>
      {user.email ? null : (
        <div className="mt-4 max-w-md">
          <AddEmailForm intro="We send a code to check it's yours. Then daily jobs can go there, and you can sign in with it." />
        </div>
      )}
      <nav aria-label="Your account" className="mt-8 grid max-w-md gap-2">
        <Link href="/profile" className={LINK}>
          Your score and sources
          <span aria-hidden className="text-ink-muted">&rarr;</span>
        </Link>
        <Link href="/welcome" className={LINK}>
          {step === "done" ? "Edit your answers" : "Finish setting up"}
          <span aria-hidden className="text-ink-muted">&rarr;</span>
        </Link>
        <Link href="/settings" className={LINK}>
          Settings
          <span aria-hidden className="text-ink-muted">&rarr;</span>
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
