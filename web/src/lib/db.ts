import { getCloudflareContext } from "@opennextjs/cloudflare";

/**
 * Оточення Worker разом з тим, чого `wrangler types` не бачить: секрети
 * (docs/contracts.md, розділ 6) і прив'язки, яких ще немає в wrangler.jsonc.
 * Усе, чого може не бути, позначене як необов'язкове: код мусить це
 * перевірити й чесно сказати, чого бракує (розділ 8). Omit, бо `wrangler types`
 * бере секрети з локального .dev.vars і зробив би їх обов'язковими.
 */
export type AppEnv = Omit<CloudflareEnv, "SESSION_SECRET" | "EMAIL" | "TWITTER_TOKEN" | "GITHUB_TOKEN"> & {
  /** Ключ HMAC для кодів входу (contracts §9). Worker secret, у розробці .dev.vars. */
  SESSION_SECRET?: string;
  /** Ключ 6551 для перевірки коду в X. Worker secret; без нього перевірка X вимкнена. */
  TWITTER_TOKEN?: string;
  /** Необов'язковий ключ GitHub: без нього перевірка GitHub іде без ключа (60 запитів/год). */
  GITHUB_TOKEN?: string;
  /** Cloudflare Email Service (send_email у wrangler.jsonc). Без нього лист добірки відповідає 503. */
  EMAIL?: SendEmail;
  /** Спільний з engine ключ підпису внутрішніх запитів (engine/src/digest/README.md). Worker secret. */
  INTERNAL_API_SECRET?: string;
  /** Адреса сайту для посилань у листах (lib/site.ts); без неї https://nextcryptojob.xyz. */
  SITE_URL?: string;
};

/** Оточення Worker. Викликати лише під час запиту. */
export function appEnv(): AppEnv {
  return getCloudflareContext().env as AppEnv;
}

/**
 * Основна база продукту (binding DB = D1 `nextcryptojob`). Без ORM: схема
 * наша, запити прості, як у NextRole. Базу вакансій бери через jobsDb().
 */
export function db(): D1Database {
  return appEnv().DB;
}
