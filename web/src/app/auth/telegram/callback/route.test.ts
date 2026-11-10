import { beforeEach, describe, expect, it, vi } from "vitest";
import { harness, resetHarness } from "@/test/harness";

vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
const finish = vi.hoisted(() => ({ path: "/account" }));
vi.mock("@/lib/auth/telegram-login", () => ({
  errorPath: (reason: string) => `/auth/telegram/error?reason=${reason}`,
  finishTelegramLogin: async () => finish.path,
}));

import { GET } from "./route";

/** Вхід через Telegram, щоб під'єднати помічника: назад на сторінку згоди, а не в кабінет. */

const AUTH = "/oauth/authorize?client_id=c&state=s";
const call = () => GET(new Request("https://nextcryptojob.xyz/auth/telegram/callback?code=x&state=y"));

beforeEach(() => {
  resetHarness();
  finish.path = "/account";
});

describe("telegram callback and the connector", () => {
  it("goes back to the consent page and drops the return cookie", async () => {
    harness.jar.set("ncj_oauth_return", encodeURIComponent(AUTH));
    const res = await call();
    expect(res.headers.get("Location")).toBe(`https://nextcryptojob.xyz${AUTH}`);
    expect(res.headers.get("Set-Cookie")).toMatch(/ncj_oauth_return=;/);
  });

  it("keeps the error page when the login failed", async () => {
    finish.path = "/auth/telegram/error?reason=expired";
    harness.jar.set("ncj_oauth_return", encodeURIComponent(AUTH));
    const res = await call();
    expect(res.headers.get("Location")).toContain("/auth/telegram/error?reason=expired");
  });

  it("ignores a return cookie that points anywhere else", async () => {
    harness.jar.set("ncj_oauth_return", encodeURIComponent("https://evil.example/oauth/authorize?x"));
    const res = await call();
    expect(res.headers.get("Location")).toBe("https://nextcryptojob.xyz/account");
  });

  it("without the cookie, the usual landing page", async () => {
    const res = await call();
    expect(res.headers.get("Location")).toBe("https://nextcryptojob.xyz/account");
  });
});
