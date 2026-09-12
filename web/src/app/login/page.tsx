import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TelegramButton } from "@/components/telegram-button";
import { currentUser } from "@/lib/auth/session";
import { telegramLoginEnabled } from "@/lib/auth/telegram-oidc";
import { telegramEnv } from "@/lib/telegram/env";
import { LoginForm } from "./login-form";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  // Хто вже ввійшов, тому форма ні до чого.
  if (await currentUser()) redirect("/account");
  // Без ключів OIDC кнопки Telegram немає зовсім (docs/contracts.md, §8).
  const telegram = telegramLoginEnabled(telegramEnv());

  return (
    <section className="mx-auto max-w-sm px-4 py-16 sm:py-24">
      <h1 className="text-3xl font-semibold tracking-tight">Sign in</h1>
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
        New here? The same step creates your account.
      </p>
      <LoginForm />
    </section>
  );
}
