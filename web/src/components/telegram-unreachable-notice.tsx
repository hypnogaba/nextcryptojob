import { BOT_URL, BOT_USERNAME } from "@/lib/telegram/bot-link";

/**
 * Позначка users.telegram_unreachable_at (0027): бот не може написати людині (не натискала Start
 * або заблокувала бота). Її ставить рушій добірки, знімає вебхук на будь-яке повідомлення боту.
 * Поки вона стоїть, сайт не каже «Telegram connected».
 */
export function TelegramUnreachableNotice({ hasEmail }: { hasEmail: boolean }) {
  return (
    <div role="status" className="grid gap-1 rounded-xl border border-line-strong bg-soft p-4">
      <p className="font-medium text-ink">
        We can&apos;t reach you on Telegram.{" "}
        <a href={BOT_URL} target="_blank" rel="noreferrer" className="underline decoration-line-strong underline-offset-4 hover:decoration-brand">
          Open @{BOT_USERNAME}
        </a>{" "}
        and press Start.
      </p>
      <p className="text-sm text-ink-muted">
        {hasEmail
          ? "Until then your daily jobs go to your email."
          : "Until then we can't send your daily jobs. Add an email to get them there instead."}
      </p>
    </div>
  );
}
