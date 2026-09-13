import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TelegramButton } from "@/components/telegram-button";
import { getSettings } from "@/lib/admin/settings";
import { currentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { telegramLoginEnabled } from "@/lib/auth/telegram-oidc";
import { telegramEnv } from "@/lib/telegram/env";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  // Хто вже ввійшов, тому форма ні до чого.
  if (await currentUser()) redirect("/account");
  // Без ключів OIDC кнопки Telegram немає зовсім (docs/contracts.md, §8).
  const telegram = telegramLoginEnabled(telegramEnv());
  // Нові реєстрації закрито в /admin/settings: хто вже має акаунт, входить як завжди.
  const { signups_open: signupsOpen } = await getSettings(db());

  return (
    <section className="mx-auto max-w-sm px-[clamp(16px,4vw,56px)] py-16 sm:max-w-md sm:py-24">
      <h1 className="display text-title">Sign in</h1>
      {signupsOpen ? null : (
        <p role="status" data-signups="closed" className="mt-4 rounded-lg border border-line-strong bg-surface px-4 py-3 text-sm text-ink">
          New sign-ups are closed for now. If you already have an account, sign in as usual.
        </p>
      )}
      {telegram ? (
        <>
          <TelegramButton className="mt-8 w-full">Continue with Telegram</TelegramButton>
          <div className="mt-8 flex items-center gap-3 text-sm text-ink-muted" aria-hidden>
            <span className="h-px flex-1 bg-line" />
            or use email
            <span className="h-px flex-1 bg-line" />
          </div>
        </>
      ) : null}
      <p className={telegram ? "mt-6 text-ink-muted" : "mt-3 text-ink-muted"}>
        Enter your email and we will send you a <span className="whitespace-nowrap">6-digit</span> code.
        {signupsOpen ? " New here? The same step creates your account." : null}
      </p>
      <LoginForm />
    </section>
  );
}
