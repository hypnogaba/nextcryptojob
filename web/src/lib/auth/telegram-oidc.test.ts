import { beforeEach, describe, expect, it, vi } from "vitest";
import { CLIENT_ID, CLIENT_SECRET, NOW, rsaSigner, telegramClaims, unsignedToken, type TestSigner } from "@/test/jwt";
import {
  authorizationUrl,
  basicAuth,
  callbackUrl,
  decodeFlow,
  encodeFlow,
  exchangeCode,
  FLOW_TTL_SECONDS,
  JWKS_URI,
  newFlow,
  OidcError,
  oidcClient,
  pkceChallenge,
  resetJwksCache,
  signingKey,
  stateMatches,
  telegramLoginEnabled,
  TOKEN_ENDPOINT,
  verifyIdToken,
  type OidcFailure,
} from "./telegram-oidc";

const client = { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET };
const NONCE = "n".repeat(43);

let signer: TestSigner;
beforeEach(async () => {
  signer ??= await rsaSigner();
  resetJwksCache();
});

const verify = (token: string, over: Partial<Parameters<typeof verifyIdToken>[1]> = {}) =>
  verifyIdToken(token, { clientId: CLIENT_ID, nonce: NONCE, nowSeconds: NOW, keyFor: async () => signer.publicKey, ...over });

async function failure(promise: Promise<unknown>): Promise<OidcFailure> {
  const err = await promise.then(
    () => null,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(OidcError);
  return (err as OidcError).reason;
}

describe("configuration", () => {
  it("is off until both client id and secret are set", () => {
    expect(telegramLoginEnabled({})).toBe(false);
    expect(telegramLoginEnabled({ TELEGRAM_OIDC_CLIENT_ID: CLIENT_ID })).toBe(false);
    expect(telegramLoginEnabled({ TELEGRAM_OIDC_CLIENT_SECRET: CLIENT_SECRET })).toBe(false);
    expect(oidcClient({ TELEGRAM_OIDC_CLIENT_ID: CLIENT_ID, TELEGRAM_OIDC_CLIENT_SECRET: CLIENT_SECRET })).toEqual(client);
  });

  it("builds the callback URL on the site's own origin", () => {
    expect(callbackUrl("https://nextcryptojob.xyz")).toBe("https://nextcryptojob.xyz/auth/telegram/callback");
  });
});

describe("state, PKCE and nonce", () => {
  it("gives each sign-in its own random state, verifier and nonce", () => {
    const a = newFlow(null, NOW);
    const b = newFlow(null, NOW);
    for (const v of [a.state, a.verifier, a.nonce]) expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set([a.state, a.verifier, a.nonce, b.state, b.verifier, b.nonce]).size).toBe(6);
  });

  it("makes the S256 challenge from RFC 7636, appendix B", async () => {
    await expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).resolves.toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
  });

  it("puts state, nonce and the challenge (never the verifier) into the authorize URL", async () => {
    const flow = newFlow(null, NOW);
    const url = new URL(await authorizationUrl(client, "https://site.test/auth/telegram/callback", flow));
    expect(url.origin + url.pathname).toBe("https://oauth.telegram.org/auth");
    const p = url.searchParams;
    expect(p.get("client_id")).toBe(CLIENT_ID);
    expect(p.get("redirect_uri")).toBe("https://site.test/auth/telegram/callback");
    expect(p.get("response_type")).toBe("code");
    expect(p.get("scope")).toBe("openid profile telegram:bot_access");
    expect(p.get("state")).toBe(flow.state);
    expect(p.get("nonce")).toBe(flow.nonce);
    expect(p.get("code_challenge")).toBe(await pkceChallenge(flow.verifier));
    expect(p.get("code_challenge_method")).toBe("S256");
    expect(url.toString()).not.toContain(flow.verifier);
  });

  it("reads back its own cookie, and nothing else", () => {
    const flow = newFlow("user-1", NOW);
    expect(decodeFlow(encodeFlow(flow), NOW + 30)).toEqual(flow);
    expect(decodeFlow(undefined, NOW)).toBeNull();
    expect(decodeFlow("not base64 !", NOW)).toBeNull();
    expect(decodeFlow(btoa(JSON.stringify({ ...flow, state: "short" })), NOW)).toBeNull();
    expect(decodeFlow(encodeFlow({ ...flow, linkUserId: 5 as unknown as string }), NOW)).toBeNull();
  });

  it("expires the cookie after 10 minutes", () => {
    const flow = newFlow(null, NOW);
    expect(decodeFlow(encodeFlow(flow), NOW + FLOW_TTL_SECONDS)).not.toBeNull();
    expect(decodeFlow(encodeFlow(flow), NOW + FLOW_TTL_SECONDS + 1)).toBeNull();
  });

  it("matches state only exactly", () => {
    const flow = newFlow(null, NOW);
    expect(stateMatches(flow, flow.state)).toBe(true);
    expect(stateMatches(flow, null)).toBe(false);
    expect(stateMatches(flow, "")).toBe(false);
    expect(stateMatches(flow, flow.state.slice(0, -1) + (flow.state.endsWith("A") ? "B" : "A"))).toBe(false);
  });
});

describe("exchangeCode", () => {
  it("posts the code with the PKCE verifier and Basic client auth", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      Response.json({ access_token: "a", token_type: "Bearer", expires_in: 3600, id_token: "the.id.token" }),
    );
    const token = await exchangeCode(client, { code: "c0de", verifier: "v".repeat(43), redirectUri: "https://s/cb" }, fetchImpl);
    expect(token).toBe("the.id.token");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(TOKEN_ENDPOINT);
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe(`Basic ${btoa(`${CLIENT_ID}:${CLIENT_SECRET}`)}`);
    expect(basicAuth(client)).toBe(headers.get("authorization"));
    expect(headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: "authorization_code",
      code: "c0de",
      redirect_uri: "https://s/cb",
      client_id: CLIENT_ID,
      code_verifier: "v".repeat(43),
    });
  });

  it("fails on an OAuth error or a response without id_token", async () => {
    const bad = async () => Response.json({ error: "invalid_grant" }, { status: 400 });
    expect(await failure(exchangeCode(client, { code: "x", verifier: "v", redirectUri: "r" }, bad))).toBe("token_exchange");
    const empty = async () => Response.json({ access_token: "a" });
    expect(await failure(exchangeCode(client, { code: "x", verifier: "v", redirectUri: "r" }, empty))).toBe("token_exchange");
    const down = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await failure(exchangeCode(client, { code: "x", verifier: "v", redirectUri: "r" }, down))).toBe("token_exchange");
  });
});

describe("verifyIdToken", () => {
  it("returns the Telegram id from the `id` claim (not `sub`), username and name", async () => {
    await expect(verify(await signer.sign(telegramClaims(NONCE)))).resolves.toEqual({
      telegramId: "987654321",
      username: "ada_l",
      name: "Ada Lovelace",
    });
  });

  it("accepts aud as a list and a token without nonce (back-channel code flow), with a warning in the log", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const claims = telegramClaims(NONCE, { aud: ["other", CLIENT_ID] });
    delete claims.nonce;
    await expect(verify(await signer.sign(claims))).resolves.toMatchObject({ telegramId: "987654321" });
    expect(warn).toHaveBeenCalledWith("telegram oidc: id token has no nonce claim");
    warn.mockRestore();
  });

  it("does not warn when the nonce is there", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await verify(await signer.sign(telegramClaims(NONCE)));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("accepts a token issued up to 10 minutes ago and rejects an older one", async () => {
    await expect(verify(await signer.sign(telegramClaims(NONCE, { iat: NOW - 600 })))).resolves.toBeTruthy();
    expect(await failure(verify(await signer.sign(telegramClaims(NONCE, { iat: NOW - 601 }))))).toBe("too_old");
  });

  it("drops a malformed username and builds the name from its parts", async () => {
    const claims = telegramClaims(NONCE, { preferred_username: "no spaces!", name: undefined, given_name: "Ada", family_name: "L" });
    await expect(verify(await signer.sign(claims))).resolves.toEqual({ telegramId: "987654321", username: null, name: "Ada L" });
  });

  it.each<[string, Record<string, unknown>, OidcFailure]>([
    ["wrong issuer", { iss: "https://evil.example" }, "wrong_issuer"],
    ["wrong audience", { aud: "999" }, "wrong_audience"],
    ["missing audience", { aud: undefined }, "wrong_audience"],
    ["expired", { exp: NOW - 61 }, "expired"],
    ["no exp", { exp: undefined }, "expired"],
    ["issued in the future", { iat: NOW + 120 }, "issued_in_future"],
    ["issued too long ago", { iat: NOW - 11 * 60 }, "too_old"],
    ["wrong nonce", { nonce: "m".repeat(43) }, "wrong_nonce"],
    ["non-string nonce", { nonce: 42 }, "wrong_nonce"],
    ["no Telegram id", { id: undefined }, "no_user_id"],
    ["non-numeric id", { id: "12ab" }, "no_user_id"],
  ])("rejects %s", async (_name, over, reason) => {
    expect(await failure(verify(await signer.sign(telegramClaims(NONCE, over))))).toBe(reason);
  });

  it("allows a minute of clock skew on exp and iat", async () => {
    await expect(verify(await signer.sign(telegramClaims(NONCE, { exp: NOW - 59, iat: NOW + 59 })))).resolves.toBeTruthy();
  });

  it("rejects a token signed with another key", async () => {
    const other = await rsaSigner();
    expect(await failure(verify(await other.sign(telegramClaims(NONCE))))).toBe("bad_signature");
  });

  it("rejects a token whose payload was changed after signing", async () => {
    const [h, , s] = (await signer.sign(telegramClaims(NONCE))).split(".");
    const forged = btoa(JSON.stringify(telegramClaims(NONCE, { id: 1 })))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(await failure(verify(`${h}.${forged}.${s}`))).toBe("bad_signature");
  });

  it("rejects alg none and HS256", async () => {
    expect(await failure(verify(unsignedToken(telegramClaims(NONCE), { alg: "none", kid: "oidc-1" })))).toBe(
      "unsupported_alg",
    );
    expect(await failure(verify(await signer.sign(telegramClaims(NONCE), { alg: "HS256" })))).toBe("unsupported_alg");
  });

  it("rejects garbage", async () => {
    expect(await failure(verify("abc"))).toBe("malformed_token");
    expect(await failure(verify("a.b.c"))).toBe("malformed_token");
  });
});

describe("JWKS", () => {
  function jwksFetch(keys: object[]) {
    return vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe(JWKS_URI);
      return Response.json({ keys });
    });
  }

  it("verifies against Telegram's JWKS, fetched once per isolate", async () => {
    const fetchImpl = jwksFetch([
      { kty: "EC", crv: "P-256", kid: "oidc-es256-1", alg: "ES256", x: "a", y: "b", use: "sig" },
      signer.jwk,
    ]);
    const keyFor = (kid: string) => signingKey(kid, fetchImpl, NOW * 1000);
    const token = await signer.sign(telegramClaims(NONCE));
    await expect(verify(token, { keyFor })).resolves.toMatchObject({ telegramId: "987654321" });
    await expect(verify(token, { keyFor })).resolves.toMatchObject({ telegramId: "987654321" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refetches for an unknown kid, at most once a minute", async () => {
    const fetchImpl = jwksFetch([signer.jwk]);
    await signingKey("oidc-1", fetchImpl, 0);
    await expect(signingKey("rotated", fetchImpl, 1_000)).rejects.toMatchObject({ reason: "unknown_key" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(signingKey("rotated", fetchImpl, 61_000)).rejects.toMatchObject({ reason: "unknown_key" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps using a known key when Telegram's JWKS is down", async () => {
    await signingKey("oidc-1", jwksFetch([signer.jwk]), 0);
    const down = vi.fn(async () => new Response("down", { status: 503 }));
    await expect(signingKey("oidc-1", down, 2 * 60 * 60 * 1000)).resolves.toBeTruthy();
    await expect(signingKey("other", down, 3 * 60 * 60 * 1000)).rejects.toMatchObject({ reason: "jwks_unavailable" });
  });
});
