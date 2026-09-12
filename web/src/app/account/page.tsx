import type { Metadata } from "next";
import { SignOutButton } from "@/components/sign-out-button";
import { requireUser } from "@/lib/auth/session";
import { TelegramPanel } from "./telegram-panel";

export const metadata: Metadata = { title: "Account", robots: { index: false } };

// Заглушка кабінету: поки лише пошта й вихід.
export default async function AccountPage() {
  const user = await requireUser();

  return (
    <section className="mx-auto max-w-5xl px-4 py-16 sm:px-6 sm:py-24">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Account</h1>
      <dl className="mt-8 grid max-w-md gap-1">
        <dt className="font-mono text-xs tracking-widest text-ink-muted uppercase">Email</dt>
        <dd className="text-ink">{user.email ?? "Not added yet"}</dd>
      </dl>
      <TelegramPanel userId={user.id} />
      <div className="mt-8">
        <SignOutButton />
      </div>
    </section>
  );
}
