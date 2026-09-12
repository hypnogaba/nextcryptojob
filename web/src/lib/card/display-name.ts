// Ім'я на публічній картці. Картка єдина публічна сторінка, тому ім'я не може
// бути гаманцем чи посиланням, а його літери мусять бути в шрифті картинки
// (набір збігається з Plex Sans у fonts/, див. scripts/card-fonts.mjs).

export const DISPLAY_NAME_MAX = 32;

// Латиниця з діакритикою (до U+017F), базова кирилиця з Ґ, цифри, пробіл і . _ ' @ -
const ALLOWED = /^[A-Za-z0-9 ._'@\-\u00C0-\u00D6\u00D8-\u00F6\u00F8-\u017F\u0400-\u045F\u0490\u0491]+$/;

const LOOKS_LIKE_WALLET = [
  /0x[0-9a-f]{6,}/i, // EVM, зокрема скорочена 0x1234ab…
  /[1-9A-HJ-NP-Za-km-z]{32,}/, // Solana base58
  /\.(eth|sol)$/i, // ENS / SNS
];
// Крапка перед двома літерами = домен (site.xyz, x.com). «J. Doe» чи «J.R.R.» лишаються.
const LOOKS_LIKE_LINK = /\.\p{L}{2,}/u;

export class DisplayNameError extends Error {}

/** Нормалізує ім'я або кидає DisplayNameError з причиною англійською. */
export function normalizeDisplayName(raw: string): string {
  const name = raw.normalize("NFC").trim().replace(/\s+/g, " ");
  if (name.length === 0) throw new DisplayNameError("Display name is empty.");
  // Спершу приватність: людина має почути, що гаманець чи посилання тут не можна.
  if (LOOKS_LIKE_WALLET.some((re) => re.test(name)) || LOOKS_LIKE_LINK.test(name)) {
    throw new DisplayNameError("Display name cannot be a wallet address or a link.");
  }
  if ([...name].length > DISPLAY_NAME_MAX) {
    throw new DisplayNameError(`Display name is longer than ${DISPLAY_NAME_MAX} characters.`);
  }
  if (!ALLOWED.test(name)) {
    throw new DisplayNameError("Display name can use letters, digits, spaces and . _ ' @ - only.");
  }
  return name;
}

/**
 * Ім'я, яке пропонуємо в полі перед створенням картки: перевірений X як
 * «@handle», інакше перша частина пошти. Людина може його змінити. Якщо з
 * пошти не виходить дозволене ім'я, поле лишається порожнім.
 */
export function suggestDisplayName(verifiedX: string | null, email: string | null): string {
  const candidates = [
    verifiedX ? `@${verifiedX}` : null,
    // ada.lovelace+jobs@… → «ada lovelace»: крапка між словами виглядала б як домен.
    email ? email.split("@")[0].split("+")[0].replace(/[._-]+/g, " ").slice(0, DISPLAY_NAME_MAX) : null,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      return normalizeDisplayName(candidate);
    } catch {
      // Наступний варіант.
    }
  }
  return "";
}

/** Чи дозволений окремий символ: для перевірки покриття шрифтом у тестах. */
export function isAllowedDisplayNameChar(char: string): boolean {
  return ALLOWED.test(char);
}
