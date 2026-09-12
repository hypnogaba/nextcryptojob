// Код підтвердження джерела: `ncj-` і 6 символів base32 (a–z, 2–7).
// Людина ставить його в біо X чи GitHub або в пост X, і так доводить, що
// акаунт її. 32^6 ≈ 10^9 варіантів: підібрати чужий код неможливо, а людині
// легко переписати.

const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const SHAPE = /^ncj-[a-z2-7]{6}$/;

export function newVerifyCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  // 256 ділиться на 32 без остачі, тож & 31 дає рівномірний символ.
  return `ncj-${Array.from(bytes, (b) => ALPHABET[b & 31]).join("")}`;
}

export function isVerifyCode(value: string | null | undefined): value is string {
  return typeof value === "string" && SHAPE.test(value);
}

/**
 * Чи є код у тексті окремим словом, без огляду на регістр. «ncj-abc234x» не
 * рахується: це інший код. NFKC зводить широкі й стилізовані літери до
 * звичайних, якими X іноді прикрашає біо.
 */
export function containsCode(text: string | null | undefined, code: string): boolean {
  if (!text || !isVerifyCode(code)) return false;
  return new RegExp(`(?<![a-z0-9])${code}(?![a-z0-9])`, "i").test(text.normalize("NFKC"));
}
