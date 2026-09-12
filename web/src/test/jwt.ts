/**
 * Локальний «Telegram» для тестів входу: власна пара ключів RSA, підпис
 * ID-токенів RS256 і JWKS у тому вигляді, як їх віддає oauth.telegram.org.
 */

const encoder = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const jsonPart = (value: unknown) => b64url(encoder.encode(JSON.stringify(value)));

export type TestSigner = {
  kid: string;
  publicKey: CryptoKey;
  jwk: JsonWebKey & { kid: string };
  sign(claims: Record<string, unknown>, header?: Record<string, unknown>): Promise<string>;
};

export async function rsaSigner(kid = "oidc-1"): Promise<TestSigner> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const exported = await crypto.subtle.exportKey("jwk", pair.publicKey);
  // Такий самий набір полів, як у справжньому JWKS Telegram.
  const jwk = { kty: "RSA", n: exported.n, e: exported.e, alg: "RS256", ext: true, key_ops: ["verify"], kid };
  return {
    kid,
    publicKey: pair.publicKey,
    jwk,
    async sign(claims, header = {}) {
      const head = jsonPart({ alg: "RS256", typ: "JWT", kid, ...header });
      const body = jsonPart(claims);
      const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, encoder.encode(`${head}.${body}`));
      return `${head}.${body}.${b64url(new Uint8Array(sig))}`;
    },
  };
}

/** Непідписаний токен з alg "none" для перевірки, що його відкидають. */
export function unsignedToken(claims: Record<string, unknown>, header: Record<string, unknown>): string {
  return `${jsonPart(header)}.${jsonPart(claims)}.`;
}

export const CLIENT_ID = "8123456789";
export const CLIENT_SECRET = "test-client-secret";
export const NOW = 1_800_000_000;

/** Типові claims від Telegram для входу з nonce. */
export function telegramClaims(nonce: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://oauth.telegram.org",
    aud: CLIENT_ID,
    sub: "1234123412341234123",
    iat: NOW - 5,
    exp: NOW + 3600,
    id: 987654321,
    name: "Ada Lovelace",
    preferred_username: "ada_l",
    nonce,
    ...over,
  };
}
