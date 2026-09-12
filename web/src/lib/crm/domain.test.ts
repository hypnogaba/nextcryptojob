import { describe, expect, it } from "vitest";
import { companySite, emailProvesDomain, isFreeMailDomain } from "./domain";

describe("company website", () => {
  it("normalizes like identities.site and takes the host without www as the domain", () => {
    expect(companySite("Acme.io/")).toEqual({ ok: true, website: "https://acme.io", domain: "acme.io" });
    expect(companySite("https://www.Acme.io/careers/")).toEqual({
      ok: true,
      website: "https://www.acme.io/careers",
      domain: "acme.io",
    });
    expect(companySite("http://acme.io").ok).toBe(false);
    expect(companySite("localhost").ok).toBe(false);
    expect(companySite("10.0.0.1").ok).toBe(false);
  });
});

describe("domain verification by the owner's email", () => {
  it("verifies the same domain and its subdomains", () => {
    expect(emailProvesDomain("dana@acme.io", "acme.io")).toBe(true);
    expect(emailProvesDomain("Dana@ACME.io", "acme.io")).toBe(true);
    expect(emailProvesDomain("dana@eng.acme.io", "acme.io")).toBe(true);
  });

  it("does not verify another domain, a look-alike or the parent of the site", () => {
    expect(emailProvesDomain("dana@acme.com", "acme.io")).toBe(false);
    expect(emailProvesDomain("dana@notacme.io", "acme.io")).toBe(false);
    expect(emailProvesDomain("dana@acme.io.evil.com", "acme.io")).toBe(false);
    // Сайт на піддомені, пошта на батьківському: правило лише «домен сайту або піддомен».
    expect(emailProvesDomain("dana@acme.io", "jobs.acme.io")).toBe(false);
  });

  it("never verifies free mail, on either side", () => {
    for (const email of [
      "dana@gmail.com",
      "dana@outlook.com",
      "dana@hotmail.com",
      "dana@yahoo.com",
      "dana@proton.me",
      "dana@protonmail.com",
      "dana@icloud.com",
      "dana@gmx.de",
      "dana@gmx.net",
      "dana@mail.ru",
      "dana@ukr.net",
    ]) {
      const domain = email.split("@")[1];
      expect(emailProvesDomain(email, domain), email).toBe(false);
    }
    expect(isFreeMailDomain("gmx.co.uk")).toBe(true);
    expect(isFreeMailDomain("yahoo.co.uk")).toBe(true);
    expect(isFreeMailDomain("acme.io")).toBe(false);
  });

  it("does not verify without an email (Telegram sign-in) or without a domain", () => {
    expect(emailProvesDomain(null, "acme.io")).toBe(false);
    expect(emailProvesDomain("dana@acme.io", null)).toBe(false);
    expect(emailProvesDomain("not-an-email", "acme.io")).toBe(false);
  });
});
