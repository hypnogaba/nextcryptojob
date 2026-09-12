import { describe, expect, it } from "vitest";
import { contentSecurityPolicy, securityHeaders } from "./csp";

function directives(csp: string): Map<string, string[]> {
  return new Map(
    csp.split(";").map((part) => {
      const [name, ...sources] = part.trim().split(/\s+/);
      return [name, sources];
    }),
  );
}

function header(key: string): string | undefined {
  return securityHeaders().find((h) => h.key === key)?.value;
}

describe("content security policy", () => {
  const csp = directives(contentSecurityPolicy());

  it("is one well-formed header value with each directive once", () => {
    const value = contentSecurityPolicy();
    expect(value).not.toMatch(/[\n\r]/);
    const names = value.split(";").map((p) => p.trim().split(/\s+/)[0]);
    expect(new Set(names).size).toBe(names.length);
  });

  it("locks the page down by default", () => {
    expect(csp.get("default-src")).toEqual(["'self'"]);
    expect(csp.get("object-src")).toEqual(["'none'"]);
    expect(csp.get("base-uri")).toEqual(["'none'"]);
    expect(csp.get("frame-ancestors")).toEqual(["'none'"]);
    expect(csp.has("upgrade-insecure-requests")).toBe(true);
  });

  it("allows Turnstile scripts and frames", () => {
    expect(csp.get("script-src")).toContain("https://challenges.cloudflare.com");
    expect(csp.get("frame-src")).toContain("https://challenges.cloudflare.com");
  });

  it("allows the Telegram OIDC redirect flow", () => {
    expect(csp.get("script-src")).toEqual(
      expect.arrayContaining(["https://telegram.org", "https://oauth.telegram.org"]),
    );
    expect(csp.get("frame-src")).toContain("https://oauth.telegram.org");
    expect(csp.get("connect-src")).toContain("https://oauth.telegram.org");
    expect(csp.get("form-action")).toContain("https://oauth.telegram.org");
  });

  it("lets billing forms continue to Stripe Checkout and the customer portal, and nowhere else", () => {
    expect(csp.get("form-action")).toEqual([
      "'self'",
      "https://oauth.telegram.org",
      "https://checkout.stripe.com",
      "https://billing.stripe.com",
    ]);
  });

  it("allows avatars from X and GitHub but no other image hosts", () => {
    expect(csp.get("img-src")).toEqual([
      "'self'",
      "data:",
      "blob:",
      "https://pbs.twimg.com",
      "https://avatars.githubusercontent.com",
    ]);
  });

  it("never allows a wildcard or eval", () => {
    const value = contentSecurityPolicy();
    expect(value).not.toMatch(/(^|\s)\*(\s|;|$)/);
    expect(value).not.toContain("'unsafe-eval'");
  });
});

describe("security headers", () => {
  it("sends the CSP produced above", () => {
    expect(header("Content-Security-Policy")).toBe(contentSecurityPolicy());
  });

  it("keeps popups working for sign-in while isolating the opener", () => {
    expect(header("Cross-Origin-Opener-Policy")).toBe("same-origin-allow-popups");
  });

  it("forbids framing, sniffing and leaking full URLs", () => {
    expect(header("X-Frame-Options")).toBe("DENY");
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(header("Strict-Transport-Security")).toMatch(/max-age=\d{8,}/);
  });
});
