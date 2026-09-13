import { describe, expect, it } from "vitest";
import { formFieldErrors, formValuesOf, jobInputOf, readJobForm } from "./job-form";
import { applyUrlOf, checkJobFields, notLiveReason, openJobLimit, X_POST_MAX, xPostText, type Job } from "./jobs";

/** Правила вакансії без бази: адреса "Apply", текст посту в X, причина "Not live", розбір форми. */

const FIELDS = {
  title: "Solidity engineer",
  description: "",
  roles: ["engineer"] as const,
  work_mode: ["remote"] as const,
  city: null,
  country: null,
  salary: null,
  apply_url: null,
  tags: [],
};

describe("apply address", () => {
  it("takes https links with a host and mailto addresses, nothing else", () => {
    expect(applyUrlOf(" https://acme.io/careers/1 ")).toBe("https://acme.io/careers/1");
    expect(applyUrlOf("mailto:jobs@acme.io?subject=Solidity")).toBe("mailto:jobs@acme.io?subject=Solidity");
    for (const bad of ["http://acme.io", "https://localhost/x", "mailto:jobs", "mailto:a@b.io,c@d.io", "data:text/html,x", `https://acme.io/${"a".repeat(1000)}`]) {
      expect({ bad, url: applyUrlOf(bad) }).toEqual({ bad, url: null });
    }
  });
});

describe("post text for X", () => {
  const origin = "https://nextcryptojob.xyz";
  it("follows the template: company, title, place, salary if set, link", () => {
    const text = xPostText({
      company: "Acme Labs",
      fields: { title: "Rust engineer", workMode: ["city"], city: "Berlin", salary: { min: 8000, max: 10000, currency: "EUR", period: "month" } },
      jobId: "job_abc",
      origin,
    });
    expect(text).toBe("Acme Labs is hiring: Rust engineer (Berlin). Salary: €8k to €10k a month. Apply: nextcryptojob.xyz/jobs/job_abc");
    const noSalary = xPostText({ company: "Acme", fields: { title: "Designer", workMode: ["remote"], city: null, salary: null }, jobId: "job_x", origin });
    expect(noSalary).toBe("Acme is hiring: Designer (Remote). Apply: nextcryptojob.xyz/jobs/job_x");
  });

  it("never passes 280 characters and never cuts the link", () => {
    const text = xPostText({
      company: "C".repeat(80),
      fields: { title: "T".repeat(120), workMode: ["remote", "city"], city: "L".repeat(80), salary: null },
      jobId: "job_AAAAAAAAAAAAAAAAAAAA",
      origin,
    });
    expect(text.length).toBeLessThanOrEqual(X_POST_MAX);
    expect(text.endsWith("Apply: nextcryptojob.xyz/jobs/job_AAAAAAAAAAAAAAAAAAAA")).toBe(true);
  });
});

describe("fields", () => {
  it("keeps one line for the title and city and drops control characters from the description", () => {
    const f = checkJobFields({ ...FIELDS, title: "  Senior \n Rust   engineer ", description: "Line one\r\nLine two", work_mode: ["city"], city: " Kyiv " });
    expect(f).toMatchObject({ title: "Senior Rust engineer", description: "Line one\nLine two", city: "Kyiv", workMode: ["city"] });
  });

  it("a salary with neither amount is no salary; an absurd one is refused", () => {
    expect(checkJobFields({ ...FIELDS, salary: { min: null, max: null, currency: "USD", period: "year" } }).salary).toBeNull();
    expect(() => checkJobFields({ ...FIELDS, salary: { min: 2_000_000, currency: "USD", period: "month" } })).toThrow("Some fields are not valid.");
  });

  it("the open job limit follows the plan", () => {
    expect([openJobLimit({ plan: "subscription" }), openJobLimit({ plan: "trial" }), openJobLimit({ plan: "pay_per_request" })]).toEqual([10, 2, 0]);
  });
});

describe("why a job is not live", () => {
  const now = new Date("2026-09-13T12:00:00Z");
  const job = (o: Partial<Job>) => ({ live: false, status: "open" as const, expires_at: "2026-10-01T00:00:00Z", ...o });
  it("names the reason from the spec", () => {
    const o = { hidden: false, access: "subscription" as const, now };
    expect(notLiveReason(job({ live: true }), o)).toBeNull();
    expect(notLiveReason(job({ status: "draft" }), o)).toBe("Draft");
    expect(notLiveReason(job({}), { ...o, hidden: true })).toBe("Hidden by NextCryptoJob");
    expect(notLiveReason(job({ expires_at: "2026-09-01T00:00:00Z" }), o)).toBe("Expired");
    expect(notLiveReason(job({}), { ...o, access: "pay_per_request" })).toBe("No active subscription");
  });
});

describe("job form", () => {
  it("reads the form into registry input and back", () => {
    const f = new FormData();
    for (const [k, v] of [
      ["title", " Rust engineer "],
      ["roles", "engineer"],
      ["roles", "nonsense"],
      ["work_mode", "remote"],
      ["salary_min", "90 000"],
      ["salary_max", ""],
      ["salary_currency", "EUR"],
      ["salary_period", "month"],
      ["tags", "Rust, , ZK"],
      ["post_on_x", "on"],
    ]) {
      f.append(k, v);
    }
    const values = readJobForm(f);
    expect(values.roles).toEqual(["engineer"]);
    const parsed = jobInputOf(values);
    expect(parsed).toEqual({
      input: {
        title: "Rust engineer",
        roles: ["engineer"],
        work_mode: ["remote"],
        city: null,
        country: null,
        salary: { min: 90000, max: null, currency: "EUR", period: "month" },
        apply_url: null,
        description: "",
        tags: ["Rust", "ZK"],
        post_on_x: true,
      },
    });
    expect(formFieldErrors({ "salary.currency": "Bad", "roles.3": "Too many", title: "Short" })).toEqual({ salary: "Bad", roles: "Too many", title: "Short" });
  });

  it("fills the edit form from a job", () => {
    const values = formValuesOf({
      job_id: "job_x",
      status: "open",
      title: "Rust engineer",
      description: "Hi",
      roles: ["engineer"],
      work_mode: ["remote", "city"],
      city: "Kyiv",
      country: "UA",
      salary: { min: 100000, max: null, currency: "USD", period: "year" },
      apply_url: "https://acme.io",
      tags: ["Rust"],
      live: true,
      created_at: "2026-09-13T00:00:00Z",
      updated_at: "2026-09-13T00:00:00Z",
      published_at: null,
      expires_at: null,
      closed_at: null,
      public_url: null,
      x_post: { state: "queued", url: null },
      stats: { digest_shown: 0, apply_clicks: 0 },
    });
    expect(values).toMatchObject({ city: "Kyiv", country: "UA", salary_min: "100000", salary_max: "", tags: "Rust", post_on_x: true });
  });
});
