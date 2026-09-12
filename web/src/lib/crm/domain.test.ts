import { describe, expect, it } from "vitest";
import { companySite, emailProvesDomain, isFreeMailDomain, registrableDomain } from "./domain";

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

  it("refuses a public suffix or a shared hosting suffix as the company site", () => {
    for (const site of ["com.ua", "ac.uk", "co.uk", "github.io", "vercel.app"]) {
      expect(companySite(site), site).toEqual({ ok: false, error: "Use the address of your own website, not a shared domain." });
    }
    // Свій сайт на такому хостингу лишається сайтом.
    expect(companySite("acme.github.io")).toMatchObject({ ok: true, domain: "acme.github.io" });
    expect(registrableDomain("eng.acme.io")).toBe("acme.io");
    expect(registrableDomain("shop.com.ua")).toBe("shop.com.ua");
  });
});

describe("domain verification by the owner's email", () => {
  it("verifies the same registrable domain, subdomains on either side included", () => {
    expect(emailProvesDomain("dana@acme.io", "acme.io")).toBe(true);
    expect(emailProvesDomain("Dana@ACME.io", "acme.io")).toBe(true);
    expect(emailProvesDomain("dana@eng.acme.io", "acme.io")).toBe(true);
    expect(emailProvesDomain("dana@acme.io", "jobs.acme.io")).toBe(true);
    expect(emailProvesDomain("dana@shop.com.ua", "shop.com.ua")).toBe(true);
  });

  it("does not verify another domain, a look-alike or a suffix", () => {
    expect(emailProvesDomain("dana@acme.com", "acme.io")).toBe(false);
    expect(emailProvesDomain("dana@notacme.io", "acme.io")).toBe(false);
    expect(emailProvesDomain("dana@acme.io.evil.com", "acme.io")).toBe(false);
    expect(emailProvesDomain("x@shop.com.ua", "com.ua")).toBe(false);
    expect(emailProvesDomain("x@uni.ac.uk", "ac.uk")).toBe(false);
    expect(emailProvesDomain("x@other.com.ua", "shop.com.ua")).toBe(false);
    // Два різні сайти на спільному хостингу це дві різні компанії.
    expect(emailProvesDomain("x@evil.github.io", "acme.github.io")).toBe(false);
    expect(emailProvesDomain("x@github.io", "acme.github.io")).toBe(false);
  });

  it("never verifies free or disposable mail, on either side", () => {
    const free = [
      "gmail.com",
      "googlemail.com",
      "outlook.com",
      "hotmail.com",
      "live.com",
      "msn.com",
      "icloud.com",
      "me.com",
      "mac.com",
      "yahoo.com",
      "aol.com",
      "proton.me",
      "protonmail.com",
      "protonmail.ch",
      "pm.me",
      "duck.com",
      "fastmail.com",
      "fastmail.fm",
      "gmx.de",
      "gmx.net",
      "gmx.co.uk",
      "web.de",
      "orange.fr",
      "free.fr",
      "laposte.net",
      "yandex.ru",
      "yandex.com",
      "mail.ru",
      "ukr.net",
      "zoho.com",
      "tutanota.com",
      "tuta.io",
      "hey.com",
      "yopmail.com",
      "mailinator.com",
      "guerrillamail.com",
      "10minutemail.com",
      "temp-mail.org",
    ];
    for (const domain of free) {
      expect(isFreeMailDomain(domain), domain).toBe(true);
      expect(emailProvesDomain(`dana@${domain}`, domain), domain).toBe(false);
    }
    expect(isFreeMailDomain("yahoo.co.uk")).toBe(true);
    expect(isFreeMailDomain("eu.gmail.com")).toBe(true);
    expect(isFreeMailDomain("acme.io")).toBe(false);
    expect(emailProvesDomain("dana@gmail.com", "acme.io")).toBe(false);
  });

  it("does not verify without an email (Telegram sign-in) or without a domain", () => {
    expect(emailProvesDomain(null, "acme.io")).toBe(false);
    expect(emailProvesDomain("dana@acme.io", null)).toBe(false);
    expect(emailProvesDomain("not-an-email", "acme.io")).toBe(false);
  });
});
