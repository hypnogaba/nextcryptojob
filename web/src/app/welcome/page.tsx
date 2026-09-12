import type { Metadata } from "next";
import { SignOutButton } from "@/components/sign-out-button";
import { requireUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "Welcome", robots: { index: false } };

// Заглушка до анкети першого входу (наступні задачі).
export default async function WelcomePage() {
  const user = await requireUser();

  return (
    <section className="mx-auto max-w-5xl px-4 py-16 sm:px-6 sm:py-24">
      <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
        {"Welcome. Let's set up your profile."}
      </h1>
      {user.email ? <p className="mt-4 text-ink-muted">Signed in as {user.email}</p> : null}
      <div className="mt-8">
        <SignOutButton />
      </div>
    </section>
  );
}
