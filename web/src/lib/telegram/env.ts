import { appEnv } from "@/lib/db";

/**
 * Секрети Telegram у Worker (docs/contracts.md, §6). Окремий тип, а не поле в
 * AppEnv: усі чотири можуть бути відсутні, і кожне місце мусить це перевірити
 * (§8: без ключів OIDC кнопка входу ховається, без токена бот мовчить).
 */
export type TelegramEnv = {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  TELEGRAM_OIDC_CLIENT_ID?: string;
  TELEGRAM_OIDC_CLIENT_SECRET?: string;
};

/** Секрети Telegram поточного запиту. Порожній рядок рахується як відсутній. */
export function telegramEnv(): TelegramEnv {
  const env = appEnv() as unknown as TelegramEnv;
  const pick = (value: string | undefined) => (value?.trim() ? value.trim() : undefined);
  return {
    TELEGRAM_BOT_TOKEN: pick(env.TELEGRAM_BOT_TOKEN),
    TELEGRAM_WEBHOOK_SECRET: pick(env.TELEGRAM_WEBHOOK_SECRET),
    TELEGRAM_OIDC_CLIENT_ID: pick(env.TELEGRAM_OIDC_CLIENT_ID),
    TELEGRAM_OIDC_CLIENT_SECRET: pick(env.TELEGRAM_OIDC_CLIENT_SECRET),
  };
}
