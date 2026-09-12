import type { Metadata } from "next";
import Link from "next/link";
import { SignOutButton } from "@/components/sign-out-button";
import { requireUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { loadAnswers } from "@/lib/onboarding/store";

const LINK =
  "flex min-h-12 items-center justify-between rounded-lg border border-line bg-surface px-4 text-base font-medium text-ink hover:border-line-strong";
import { TelegramPanel } from "./telegram-panel";

export const metadata: Metadata = { title: "Account", robots: { index: false } };

// Кабінет: пошта, профіль з балом, анкета, вихід.
export default async function AccountPage() {
  const user = await requireUser();
  const { step } = await loadAnswers(db(), user.id);

  return (
    <section className="mx-auto max-w-5xl px-4 py-16 sm:px-6 sm:py-24">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Account</h1>
      <dl className="mt-8 grid max-w-md gap-1">
        <dt className="font-mono text-xs tracking-widest text-ink-muted uppercase">Email</dt>
        <dd className="text-ink">{user.email ?? "Not added yet"}</dd>
      </dl>
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
        <Link href="/company/start" className={LINK}>
          Hiring? Company account
          <span aria-hidden className="text-ink-muted">&rarr;</span>
        </Link>
      </nav>
      <TelegramPanel userId={user.id} />
      <div className="mt-8">
        <SignOutButton />
      </div>
    </section>
  );
}
