import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { newId } from "@/lib/ids";
import { addCompany, addSubscription, crmDb, run } from "@/test/crm-fixtures";
import { harness, resetHarness, rows } from "@/test/harness";
import { GET, HEAD } from "./apply/route";
import JobPage, { generateMetadata } from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

class NotFoundCalled extends Error {}
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  notFound: (): never => {
    throw new NotFoundCalled("notFound()");
  },
}));

/**
 * Публічна сторінка вакансії компанії /jobs/<id> і перехід "Apply" (специфікація 5.6):
 * лише жива вакансія; розмітка JobPosting для пошуковиків; "Apply" рахує перехід і веде на
 * адресу компанії; закрита, прихована чи без підписки: "This job is closed." і лічильник стоїть.
 */

let company: string;

beforeEach(() => {
  resetHarness({ SITE_URL: "https://nextcryptojob.xyz" } as never);
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
  company = addCompany(raw, { name: "Acme <Labs>" });
  run(raw, "UPDATE companies SET domain = 'acme.io', domain_verified_at = datetime('now') WHERE id = ?", company);
  addSubscription(raw, company);
});

function addJob(o: { status?: string; applyUrl?: string; workMode?: string; city?: string | null; salary?: boolean; description?: string } = {}): string {
  const id = newId("job");
  run(
    harness.raw,
    `INSERT INTO company_jobs (id, company_id, status, title, description, roles, remote_mode, city, country, salary_min, salary_max,
                               salary_currency, salary_period, apply_url, tags, created_via, published_at, expires_at)
     VALUES (?, ?, ?, 'Senior Solidity engineer', ?, '["engineer","security_auditor"]', ?, ?, 'PT', ?, ?, ?, 'year', ?, '["DeFi"]',
             'web', '2026-09-10 09:00:00', datetime('now', '+30 days'))`,
    id,
    company,
    o.status ?? "open",
    o.description ?? "Build lending markets.\nShip audited contracts.",
    o.workMode ?? "remote,city",
    o.city === undefined ? "Lisbon" : o.city,
    o.salary === false ? null : 120000,
    o.salary === false ? null : 150000,
    o.salary === false ? null : "USD",
    o.applyUrl ?? "https://acme.io/careers/solidity",
  );
  return id;
}

const params = (id: string) => ({ params: Promise.resolve({ id }) });

async function render(id: string): Promise<string> {
  return renderToStaticMarkup(await JobPage(params(id)));
}

function jsonLd(html: string): Record<string, unknown> {
  const m = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  expect(m).not.toBeNull();
  return JSON.parse(m![1]);
}

const apply = (id: string, headers: Record<string, string> = {}) =>
  GET(new Request(`https://nextcryptojob.xyz/jobs/${id}/apply`, { headers }), params(id));

describe("/jobs/<id>", () => {
  it("shows a live job: title, company, place, salary, roles, description and an Apply link through /apply", async () => {
    const id = addJob();
    const html = await render(id);
    expect(html).toContain("Senior Solidity engineer");
    expect(html).toContain("Acme &lt;Labs&gt;");
    expect(html).toContain("acme.io (domain verified)");
    expect(html).toContain("Remote or Lisbon · Portugal · $120k to $150k");
    expect(html).toContain("Security auditor");
    expect(html).toContain("Build lending markets.\nShip audited contracts.");
    expect(html).toContain(`href="/jobs/${id}/apply"`);
    // Адреси компанії на сторінці немає: перехід лише через /apply, щоб його порахувати.
    expect(html).not.toContain("acme.io/careers");
  });

  it("carries valid JobPosting data for search engines, with the tag-closing text escaped", async () => {
    const id = addJob();
    const html = await render(id);
    expect(html).not.toContain("<Labs>");
    const ld = jsonLd(html);
    expect(ld).toMatchObject({
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "Senior Solidity engineer",
      description: "Build lending markets.\nShip audited contracts.",
      datePosted: "2026-09-10T09:00:00Z",
      directApply: false,
      url: `https://nextcryptojob.xyz/jobs/${id}`,
      identifier: { "@type": "PropertyValue", name: "Acme <Labs>", value: id },
      hiringOrganization: { "@type": "Organization", name: "Acme <Labs>", sameAs: "https://acme.io" },
      jobLocationType: "TELECOMMUTE",
      applicantLocationRequirements: { "@type": "Country", name: "Portugal" },
      jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "Lisbon", addressCountry: "PT" } },
      baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: { "@type": "QuantitativeValue", minValue: 120000, maxValue: 150000, unitText: "YEAR" } },
    });
    expect(Date.parse(ld.validThrough as string)).toBeGreaterThan(Date.now());
    // Обов'язкові поля Google для JobPosting.
    for (const key of ["title", "description", "datePosted", "hiringOrganization"]) expect(ld[key]).toBeTruthy();
    expect(ld.jobLocation ?? ld.jobLocationType).toBeTruthy();
  });

  it("a remote job without a salary or description still has the required fields and no made-up ones", async () => {
    const id = addJob({ workMode: "remote", city: null, salary: false, description: "" });
    const ld = jsonLd(await render(id));
    expect(ld).toMatchObject({ jobLocationType: "TELECOMMUTE", description: "Senior Solidity engineer at Acme <Labs>." });
    expect(ld).not.toHaveProperty("jobLocation");
    expect(ld).not.toHaveProperty("baseSalary");
  });

  it("has a title, description and canonical address for search engines", async () => {
    const id = addJob();
    const meta = await generateMetadata(params(id));
    expect(meta.title).toBe("Senior Solidity engineer at Acme <Labs>");
    expect(meta.alternates?.canonical).toBe(`/jobs/${id}`);
    expect(String(meta.description)).toContain("Acme <Labs> is hiring: Senior Solidity engineer (Remote or Lisbon, $120k to $150k).");
  });

  it("a closed, hidden, expired, draft or unknown job is not found (This job is closed.) and not indexed", async () => {
    const closed = addJob({ status: "closed" });
    const hidden = addJob();
    run(harness.raw, "UPDATE company_jobs SET hidden_by_admin_at = datetime('now') WHERE id = ?", hidden);
    const expired = addJob();
    run(harness.raw, "UPDATE company_jobs SET expires_at = datetime('now', '-1 minute') WHERE id = ?", expired);
    const draft = addJob({ status: "draft" });
    for (const id of [closed, hidden, expired, draft, newId("job"), "nope"]) {
      await expect(render(id)).rejects.toBeInstanceOf(NotFoundCalled);
      expect((await generateMetadata(params(id))).robots).toEqual({ index: false, follow: true });
    }
    const { default: Closed } = await import("./not-found");
    expect(renderToStaticMarkup(Closed())).toContain("This job is closed.");
  });

  it("a live job of a company whose subscription lapsed is closed too", async () => {
    const id = addJob();
    run(harness.raw, "UPDATE subscriptions SET status = 'canceled'");
    await expect(render(id)).rejects.toBeInstanceOf(NotFoundCalled);
  });
});

describe("/jobs/<id>/apply", () => {
  it("counts the click and sends the candidate to the company's address", async () => {
    const id = addJob();
    const res = await apply(id);
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://acme.io/careers/solidity");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    await apply(id);
    expect(rows("SELECT apply_clicks FROM company_jobs WHERE id = ?", id)).toEqual([{ apply_clicks: 2 }]);
  });

  it("a mailto address works the same way", async () => {
    const id = addJob({ applyUrl: "mailto:jobs@acme.io" });
    expect((await apply(id)).headers.get("Location")).toBe("mailto:jobs@acme.io");
  });

  it("a browser prefetch and a HEAD request are not clicks", async () => {
    const id = addJob();
    expect((await apply(id, { "sec-purpose": "prefetch" })).headers.get("Location")).toBe("https://acme.io/careers/solidity");
    const head = await HEAD(new Request(`https://nextcryptojob.xyz/jobs/${id}/apply`, { method: "HEAD" }), params(id));
    expect(head.status).toBe(302);
    expect(rows("SELECT apply_clicks FROM company_jobs WHERE id = ?", id)).toEqual([{ apply_clicks: 0 }]);
  });

  it("a job that is not live goes back to its page and the counter does not move", async () => {
    const id = addJob({ status: "closed" });
    const res = await apply(id);
    expect(res.headers.get("Location")).toBe(`/jobs/${id}`);
    expect(rows("SELECT apply_clicks FROM company_jobs WHERE id = ?", id)).toEqual([{ apply_clicks: 0 }]);
    expect((await apply("../admin")).headers.get("Location")).toBe("/jobs/..%2Fadmin");
  });

  it("an address that is not https or mailto is never a redirect target", async () => {
    const id = addJob();
    run(harness.raw, "UPDATE company_jobs SET apply_url = 'javascript:alert(1)' WHERE id = ?", id);
    expect((await apply(id)).headers.get("Location")).toBe(`/jobs/${id}`);
  });
});
