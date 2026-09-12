// Адреса картки: /c/<slug>. 10 символів з 64 = 60 біт випадковості, тож
// сусідні картки не вгадати, а збіг двох адрес практично неможливий.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export const SLUG_LENGTH = 10;
export const SLUG_PATTERN = /^[A-Za-z0-9_-]{10}$/;

export function newSlug(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(SLUG_LENGTH));
  // 256 ділиться на 64 без остачі, тому & 63 не зсуває розподіл.
  return Array.from(bytes, (b) => ALPHABET[b & 63]).join("");
}

export function isSlug(value: string): boolean {
  return SLUG_PATTERN.test(value);
}
