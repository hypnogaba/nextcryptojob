import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  // Хто вже ввійшов, тому форма ні до чого.
  if (await currentUser()) redirect("/account");

  return (
    <section className="mx-auto max-w-sm px-4 py-16 sm:py-24">
      <h1 className="text-3xl font-semibold tracking-tight">Sign in</h1>
      <p className="mt-3 text-ink-muted">
        Enter your email and we will send you a 6-digit code. New here? The same step creates your account.
      </p>
      <LoginForm />
    </section>
  );
}
