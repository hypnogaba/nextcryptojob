import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { HTTPFacilitatorClient, type FacilitatorClient } from "@x402/core/server";
import type { FacilitatorSettings } from "./config";

/**
 * Клієнт фасилітатора x402 (специфікація CRM, розділ 7.3).
 *
 * CDP (https://api.cdp.coinbase.com/platform/v2/x402) вимагає на кожен запит
 * Bearer JWT, підписаний ключем CDP_API_KEY_ID/CDP_API_KEY_SECRET, з claim
 * `uris: ["<METHOD> <host><path>"]`, тому токен окремий для verify, settle і supported
 * (https://docs.cdp.coinbase.com/api-reference/v2/authentication).
 *
 * JWT підписує `generateJwt` з `@coinbase/cdp-sdk/auth`, а не власний код на WebCrypto.
 * Перевірено 2026-09-12 у збірці OpenNext: `cf:build` проходить, у Worker потрапляють
 * лише jose і uncrypto (axios з того ж модуля Turbopack викидає, бо пакет sideEffects:false),
 * +31 КіБ (+8 КіБ gzip); у `wrangler dev` (workerd) підписи Ed25519 і ES256 правильні.
 * Та сама функція стоїть за офіційним `@coinbase/x402`, тож формат токена збігається з CDP.
 *
 * x402.org (тестові мережі в розробці) працює без автентифікації.
 */

/** Шляхи фасилітатора, для яких HTTPFacilitatorClient просить заголовки. */
const CDP_ROUTES = [
  ["verify", "POST"],
  ["settle", "POST"],
  ["supported", "GET"],
] as const;

type AuthHeaders = { verify: Record<string, string>; settle: Record<string, string>; supported: Record<string, string> };

// AlgorithmIdentifier { id-ecPublicKey, prime256v1 } у DER.
const EC_P256_ALGORITHM = [0x30, 0x13, 0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  for (let v = n; v > 0; v >>= 8) bytes.unshift(v & 0xff);
  return [0x80 | bytes.length, ...bytes];
}

function pemBody(pem: string): Uint8Array {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function toPem(label: string, der: number[]): string {
  const b64 = btoa(String.fromCharCode(...der));
  return `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * Приводить секрет CDP до вигляду, який приймає generateJwt:
 * - `\n` літералами (так секрет часто кладуть у `wrangler secret put`) стають переносами рядка;
 * - ключ ES256 у форматі SEC1 ("BEGIN EC PRIVATE KEY", так його віддає портал CDP)
 *   загортається в PKCS#8: generateJwt читає EC лише через importPKCS8 і SEC1 відкидає.
 * Ключі Ed25519 (base64, 64 байти) і PKCS#8 проходять без змін.
 */
export function normalizeCdpSecret(secret: string): string {
  const s = secret.trim().replace(/\\n/g, "\n");
  if (!s.includes("BEGIN EC PRIVATE KEY")) return s;
  const sec1 = Array.from(pemBody(s));
  const octet = [0x04, ...derLength(sec1.length), ...sec1];
  const body = [0x02, 0x01, 0x00, ...EC_P256_ALGORITHM, ...octet];
  return toPem("PRIVATE KEY", [0x30, ...derLength(body.length), ...body]);
}

/**
 * `createAuthHeaders` для HTTPFacilitatorClient: об'єкт за шляхами, у кожному свій JWT.
 * Токен живе 120 с (типове значення generateJwt) і створюється на кожен виклик,
 * тож ні кеша, ні повторного використання nonce немає.
 */
export function cdpAuthHeaders(apiKeyId: string, apiKeySecret: string, baseUrl: string): () => Promise<AuthHeaders> {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, "");
  apiKeySecret = normalizeCdpSecret(apiKeySecret);
  const bearer = async (method: string, path: string) => ({
    Authorization: `Bearer ${await generateJwt({
      apiKeyId,
      apiKeySecret,
      requestMethod: method,
      requestHost: url.host,
      requestPath: `${basePath}/${path}`,
    })}`,
  });
  return async () => {
    const [verify, settle, supported] = await Promise.all(CDP_ROUTES.map(([path, method]) => bearer(method, path)));
    return { verify, settle, supported };
  };
}

export interface FacilitatorOptions {
  /** Межа на один запит до фасилітатора, мс. Типово 30 000, як у бібліотеці. */
  timeoutMs?: number;
}

export function createFacilitatorClient(settings: FacilitatorSettings, options: FacilitatorOptions = {}): FacilitatorClient {
  if (settings.kind === "cdp") {
    if (!settings.auth) throw new Error("CDP facilitator needs CDP_API_KEY_ID and CDP_API_KEY_SECRET");
    return new HTTPFacilitatorClient({
      url: settings.url,
      timeoutMs: options.timeoutMs,
      createAuthHeaders: cdpAuthHeaders(settings.auth.apiKeyId, settings.auth.apiKeySecret, settings.url),
    });
  }
  return new HTTPFacilitatorClient({ url: settings.url, timeoutMs: options.timeoutMs });
}
