/**
 * Криптографія входу на Web Crypto: той самий код працює у Worker і в Node
 * (тести). Секрети в базу потрапляють лише як хеш (docs/contracts.md, §9).
 */

const encoder = new TextEncoder();

function toHex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> | null {
  if (!/^(?:[0-9a-f]{2})+$/i.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Випадковий непрозорий токен: 32 байти, base64url без доповнення (43 символи). */
export function randomToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Порівняння рядків без раннього виходу: час не каже, скільки перших символів
 * збіглося. Довжину видає, але секрети тут однієї відомої довжини.
 */
export function safeEqual(a: string, b: string): boolean {
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret, "sign");
  return toHex(await crypto.subtle.sign("HMAC", key, encoder.encode(message)));
}

/**
 * Чи збігається HMAC повідомлення з очікуваним (hex). Порівнює сам
 * crypto.subtle.verify, за сталий час: рядки через === видали б, скільки
 * перших символів збіглося. Повідомлення рядком (UTF-8) або сирими байтами:
 * підпис тіла запиту рахують над байтами, як вони прийшли, до будь-якого розбору.
 */
export async function hmacSha256Verify(
  secret: string,
  message: string | Uint8Array<ArrayBuffer>,
  expectedHex: string,
): Promise<boolean> {
  const expected = fromHex(expectedHex);
  if (!expected || expected.length !== 32) return false;
  const key = await hmacKey(secret, "verify");
  const bytes = typeof message === "string" ? encoder.encode(message) : message;
  return crypto.subtle.verify("HMAC", key, expected, bytes);
}
