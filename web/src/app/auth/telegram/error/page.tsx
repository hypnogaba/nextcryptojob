import type { Metadata } from "next";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { currentUser } from "@/lib/auth/session";
import { isTelegramErrorReason, TELEGRAM_ERRORS } from "@/lib/auth/telegram-login";

export const metadata: Metadata = { title: "Telegram sign-in", robots: { index: false } };

/** Що пішло не так із входом через Telegram. Текст лише з переліку, не з адреси. */
export default async function TelegramErrorPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { reason } = await searchParams;
  const message = isTelegramErrorReason(reason) ? TELEGRAM_ERRORS[reason] : TELEGRAM_ERRORS.failed;
  const user = await currentUser();

  return (
    <section className="mx-auto max-w-sm px-4 py-16 sm:py-24">
      <h1 className="text-3xl font-semibold tracking-tight">Telegram sign-in</h1>
      <p role="alert" className="mt-3 text-ink">
        {message}
      </p>
      <Button asChild variant="outline" className="mt-8 h-11 px-4 text-base">
        <Link href={user ? "/account" : "/login"}>{user ? "Back to your account" : "Back to sign in"}</Link>
      </Button>
    </section>
  );
}
