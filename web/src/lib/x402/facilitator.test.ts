import { generateKeyPairSync, verify as verifySignature, createPublicKey, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { createFacilitatorClient, normalizeCdpSecret } from "./facilitator";
import { CDP_FACILITATOR_URL, X402ORG_FACILITATOR_URL, type FacilitatorSettings } from "./config";

type Seen = { method: string; url: string; auth: string | null };

function stubFacilitator() {
  const seen: Seen[] = [];
  vi.stubGlobal("fetch", async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    seen.push({ method: init?.method ?? "GET", url, auth: headers.get("authorization") });
    if (url.endsWith("/supported")) return Response.json({ kinds: [], extensions: [], signers: {} });
    if (url.endsWith("/verify")) return Response.json({ isValid: true, payer: "0xpayer" });
    return Response.json({ success: true, transaction: "0xtx", network: "eip155:84532" });
  });
  return seen;
}

function cdpSettings(apiKeyId: string, apiKeySecret: string): FacilitatorSettings {
  const settings = { kind: "cdp" as const, url: CDP_FACILITATOR_URL };
  Object.defineProperty(settings, "auth", { value: { apiKeyId, apiKeySecret }, enumerable: false });
  return settings;
}

function ed25519Secret() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const d = Buffer.from(privateKey.export({ format: "jwk" }).d!, "base64url");
  const x = Buffer.from(publicKey.export({ format: "jwk" }).x!, "base64url");
  return { secret: Buffer.concat([d, x]).toString("base64"), publicKey };
}

/** Перевіряє підпис JWT справжнім публічним ключем і повертає заголовок і claims. */
function readJwt(bearer: string | null, publicKey: KeyObject, alg: "EdDSA" | "ES256") {
  expect(bearer).toMatch(/^Bearer /);
  const [h, p, s] = bearer!.slice(7).split(".");
  const data = Buffer.from(`${h}.${p}`);
  const signature = Buffer.from(s, "base64url");
  const ok =
    alg === "EdDSA"
      ? verifySignature(null, data, publicKey, signature)
      : verifySignature("sha256", data, { key: publicKey, dsaEncoding: "ieee-p1363" }, signature);
  expect(ok).toBe(true);
  return { header: JSON.parse(Buffer.from(h, "base64url").toString()), claims: JSON.parse(Buffer.from(p, "base64url").toString()) };
}

const requirements: PaymentRequirements = {
  scheme: "exact",
  network: "eip155:84532",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  amount: "500000",
  payTo: "0x1111111111111111111111111111111111111111",
  maxTimeoutSeconds: 60,
  extra: { name: "USDC", version: "2" },
};
const payload: PaymentPayload = { x402Version: 2, accepted: requirements, payload: { signature: "0xsig" } };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CDP facilitator", () => {
  it("signs a separate Ed25519 JWT for each call, bound to its method and path", async () => {
    const seen = stubFacilitator();
    const { secret, publicKey } = ed25519Secret();
    const client = createFacilitatorClient(cdpSettings("organizations/o/apiKeys/k", secret));

    await client.getSupported();
    await client.verify(payload, requirements);
    await client.settle(payload, requirements);

    expect(seen.map((s) => `${s.method} ${s.url}`)).toEqual([
      `GET ${CDP_FACILITATOR_URL}/supported`,
      `POST ${CDP_FACILITATOR_URL}/verify`,
      `POST ${CDP_FACILITATOR_URL}/settle`,
    ]);
    const expectedUris = [
      "GET api.cdp.coinbase.com/platform/v2/x402/supported",
      "POST api.cdp.coinbase.com/platform/v2/x402/verify",
      "POST api.cdp.coinbase.com/platform/v2/x402/settle",
    ];
    const now = Math.floor(Date.now() / 1000);
    seen.forEach((call, i) => {
      const { header, claims } = readJwt(call.auth, publicKey, "EdDSA");
      expect(header).toMatchObject({ alg: "EdDSA", kid: "organizations/o/apiKeys/k", typ: "JWT" });
      expect(header.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(claims).toMatchObject({ sub: "organizations/o/apiKeys/k", iss: "cdp", uris: [expectedUris[i]] });
      expect(claims.exp - claims.nbf).toBe(120);
      expect(Math.abs(claims.nbf - now)).toBeLessThan(5);
    });
  });

  it("accepts an ES256 key in the SEC1 form the CDP portal hands out, even with escaped newlines", async () => {
    const seen = stubFacilitator();
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    const sec1 = (privateKey.export({ format: "pem", type: "sec1" }) as string).replace(/\n/g, "\\n");
    const client = createFacilitatorClient(cdpSettings("key-ec", sec1));

    await client.verify(payload, requirements);

    const { header } = readJwt(seen[0].auth, createPublicKey(publicKey.export({ format: "pem", type: "spki" })), "ES256");
    expect(header).toMatchObject({ alg: "ES256", kid: "key-ec" });
  });

  it("leaves Ed25519 and PKCS#8 secrets as they are", () => {
    const { secret } = ed25519Secret();
    expect(normalizeCdpSecret(secret)).toBe(secret);
    const pkcs8 = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey.export({ format: "pem", type: "pkcs8" }) as string;
    expect(normalizeCdpSecret(pkcs8)).toBe(pkcs8.trim());
  });
});

describe("x402.org facilitator", () => {
  it("sends no Authorization header", async () => {
    const seen = stubFacilitator();
    const client = createFacilitatorClient({ kind: "x402org", url: X402ORG_FACILITATOR_URL });
    await client.getSupported();
    await client.verify(payload, requirements);
    expect(seen.map((s) => s.url)).toEqual([`${X402ORG_FACILITATOR_URL}/supported`, `${X402ORG_FACILITATOR_URL}/verify`]);
    expect(seen.every((s) => s.auth === null)).toBe(true);
  });
});
