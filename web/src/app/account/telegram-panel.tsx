import { TelegramButton } from "@/components/telegram-button";
import { telegramLoginEnabled } from "@/lib/auth/telegram-oidc";
import { db } from "@/lib/db";
import { telegramStatus } from "@/lib/telegram/channel";
import { telegramEnv } from "@/lib/telegram/env";
import { cn } from "@/lib/utils";
import { setChannelAction } from "./telegram-actions";

/**
 * Telegram у кабінеті: «Connect Telegram» або стан прив'язки й перемикач
 * каналу щоденних вакансій. Без ключів OIDC і без прив'язки блоку немає (§8).
 */
export async function TelegramPanel({ userId }: { userId: string }) {
  const status = await telegramStatus(db(), userId);
  if (!status) return null;
  const canConnect = telegramLoginEnabled(telegramEnv());
  if (!status.telegramId && !canConnect) return null;

  return (
    <section aria-labelledby="telegram-heading" className="mt-10 grid max-w-md gap-3">
      <h2 id="telegram-heading" className="font-mono text-xs tracking-widest text-ink-muted uppercase">
        Telegram
      </h2>
      {status.telegramId ? (
        <>
          <p className="text-ink">
            Connected
            {status.username ? (
              <>
                {" as "}
                <span className="font-medium">@{status.username}</span>
              </>
            ) : null}
          </p>
          <ChannelSwitch on={status.channel === "telegram"} hasEmail={status.email !== null} />
        </>
      ) : (
        <>
          <p className="text-ink-muted">Connect Telegram to sign in with it and get your daily jobs in the chat.</p>
          <TelegramButton variant="outline" className="w-fit">
            Connect Telegram
          </TelegramButton>
        </>
      )}
    </section>
  );
}

function ChannelSwitch({ on, hasEmail }: { on: boolean; hasEmail: boolean }) {
  // Хто прийшов лише з Telegram, пошти не має: вимкнути Telegram нема на що.
  const locked = on && !hasEmail;
  const note = locked
    ? "Daily jobs go to Telegram. Add an email above to switch."
    : on
      ? "Daily jobs go to Telegram."
      : "Daily jobs go to your email.";

  return (
    <form action={setChannelAction} className="grid gap-1">
      <input type="hidden" name="channel" value={on ? "email" : "telegram"} />
      <div className="flex min-h-12 items-center justify-between gap-4 rounded-lg border border-line bg-surface pl-4 pr-1">
        <span id="channel-label" className="text-ink">
          Use Telegram for daily jobs
        </span>
        <button
          type="submit"
          role="switch"
          aria-checked={on}
          aria-labelledby="channel-label"
          aria-describedby="channel-note"
          disabled={locked}
          className="group inline-flex h-11 w-14 shrink-0 items-center justify-center rounded-full focus-visible:ring-3 focus-visible:ring-ring/40 focus-visible:outline-none disabled:opacity-50"
        >
          <span
            aria-hidden
            className={cn(
              "relative h-7 w-12 rounded-full transition-colors",
              on ? "bg-brand" : "bg-line-strong",
            )}
          >
            <span
              className={cn(
                "absolute top-1 left-1 size-5 rounded-full bg-surface shadow-sm transition-transform motion-reduce:transition-none",
                on ? "translate-x-5" : "translate-x-0",
              )}
            />
          </span>
        </button>
      </div>
      <p id="channel-note" className="text-sm text-ink-muted">
        {note}
      </p>
    </form>
  );
}
