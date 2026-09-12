/**
 * Заголовки безпеки й CSP. Єдине місце, де вони задаються: next.config.ts
 * лише бере securityHeaders() звідси.
 *
 * CSP без nonce: App Router вбудовує скрипти гідрації inline, а сторінки
 * віддаються статичними, тож script-src мусить пускати 'unsafe-inline'.
 * Решта директив закрита до 'self' плюс явно названі чужі джерела нижче.
 *
 * Як додати нове джерело (наступні задачі):
 * - Допиши походження (схема + хост, без шляху) у потрібні директиви
 *   DIRECTIVES з коментарем, навіщо воно. Лише ті директиви, які справді
 *   потрібні: скрипт, фрейм, запит, картинка чи відправка форми.
 * - Stripe Checkout / Elements: script-src і frame-src `https://js.stripe.com`,
 *   frame-src `https://hooks.stripe.com`, connect-src `https://api.stripe.com`.
 *   Перенаправлення на checkout.stripe.com окремого дозволу не потребує.
 * - Гаманці (підпис для підтвердження адреси): провайдери, вбудовані в
 *   браузер, дозволів не потребують. WalletConnect: connect-src
 *   `https://*.walletconnect.com wss://*.walletconnect.com
 *   https://*.walletconnect.org wss://*.walletconnect.org`, frame-src
 *   `https://verify.walletconnect.com https://verify.walletconnect.org`.
 * - Онови тест csp.test.ts: він фіксує, що саме дозволено.
 */

const TURNSTILE = "https://challenges.cloudflare.com";
const TELEGRAM_OAUTH = "https://oauth.telegram.org";
const TELEGRAM = "https://telegram.org";

export const DIRECTIVES: Readonly<Record<string, readonly string[]>> = {
  "default-src": ["'self'"],
  // Turnstile (антибот) і віджет входу Telegram вантажать свої скрипти.
  "script-src": ["'self'", "'unsafe-inline'", TURNSTILE, TELEGRAM, TELEGRAM_OAUTH],
  "style-src": ["'self'", "'unsafe-inline'"],
  // Аватарки з X і GitHub на картці людини.
  "img-src": [
    "'self'",
    "data:",
    "blob:",
    "https://pbs.twimg.com",
    "https://avatars.githubusercontent.com",
  ],
  "font-src": ["'self'", "data:"],
  "connect-src": ["'self'", TELEGRAM_OAUTH],
  // Turnstile малює перевірку у фреймі; вхід Telegram відкривається у фреймі або вікні.
  "frame-src": [TURNSTILE, TELEGRAM_OAUTH],
  "object-src": ["'none'"],
  "base-uri": ["'none'"],
  // Вхід Telegram OIDC: форма й перенаправлення йдуть на oauth.telegram.org.
  "form-action": ["'self'", TELEGRAM_OAUTH],
  "frame-ancestors": ["'none'"],
  "upgrade-insecure-requests": [],
};

export function contentSecurityPolicy(): string {
  return Object.entries(DIRECTIVES)
    .map(([name, sources]) => [name, ...sources].join(" "))
    .join("; ");
}

export type Header = { key: string; value: string };

export function securityHeaders(): Header[] {
  return [
    { key: "Content-Security-Policy", value: contentSecurityPolicy() },
    { key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    { key: "X-Frame-Options", value: "DENY" },
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), interest-cohort=()" },
    // allow-popups: вхід через Telegram відкриває вікно, яке мусить повернути
    // результат відкривачу. Повне same-origin розірвало б цей зв'язок.
    { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
  ];
}
