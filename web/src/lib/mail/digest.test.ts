import { describe, expect, it } from "vitest";
import { DIGEST_FOOTER_REASON, digestEmail, type DigestEmailJob } from "./digest";

const job = (over: Partial<DigestEmailJob> = {}): DigestEmailJob => ({
  position: 1,
  title: "Protocol Engineer",
  company: "Paying Labs",
  location: "Remote",
  salary: "$120k to $150k",
  why: "Matches your Engineer role. Remote. Salary listed: $120k to $150k.",
  url: "https://jobs.example.com/1",
  posted_by: null,
  ...over,
});

const ORIGIN = "https://nextcryptojob.xyz";
const UNSUB = "https://nextcryptojob.xyz/api/digest/unsubscribe?u=ada&t=abc";

describe("digestEmail", () => {
  it("counts the jobs in the subject", () => {
    expect(digestEmail({ localDate: "2026-09-12", jobs: [job()], site: ORIGIN, unsubscribeUrl: UNSUB }).subject).toBe("Your 1 crypto job for Sep 12");
    const five = [1, 2, 3, 4, 5].map((position) => job({ position }));
    expect(digestEmail({ localDate: "2026-09-03", jobs: five, site: ORIGIN, unsubscribeUrl: UNSUB }).subject).toBe("Your 5 crypto jobs for Sep 3");
  });

  it("lists each job with title, company, place, salary, why and link, in position order", () => {
    const mail = digestEmail({
      localDate: "2026-09-12",
      jobs: [
        job({ position: 2, title: "Second", company: "Acme", location: null, salary: null, posted_by: "Acme", url: "https://nextcryptojob.xyz/jobs/job_1" }),
        job(),
      ],
      site: ORIGIN, unsubscribeUrl: UNSUB,
    });
    expect(mail.text).toBe(
      [
        "Your 2 crypto jobs for Sep 12",
        "1. Protocol Engineer\nPaying Labs · Remote · $120k to $150k\nMatches your Engineer role. Remote. Salary listed: $120k to $150k.\nhttps://jobs.example.com/1",
        "2. Second\nAcme\nMatches your Engineer role. Remote. Salary listed: $120k to $150k.\nPosted by Acme on NextCryptoJob\nhttps://nextcryptojob.xyz/jobs/job_1",
        `All jobs we sent you: ${ORIGIN}/jobs\nChange the channel or the hour: ${ORIGIN}/settings\nPause daily jobs: ${UNSUB}\n${DIGEST_FOOTER_REASON}`,
      ].join("\n\n") + "\n",
    );
    expect(mail.html).toContain('<a href="https://jobs.example.com/1" style="color:#0b6e63">1. Protocol Engineer</a>');
    expect(mail.html).toContain("Posted by Acme on NextCryptoJob");
    expect(mail.html).toContain(DIGEST_FOOTER_REASON);
    expect(mail.html).toContain(`href="${ORIGIN}/settings"`);
  });

  it("escapes every field in HTML, attributes included", () => {
    const mail = digestEmail({
      localDate: "2026-09-12",
      jobs: [
        job({
          title: "<img src=x onerror=alert(1)>",
          company: "Tom & Jerry's",
          location: "<b>Paris</b>",
          salary: "<i>$1M</i>",
          why: "</p><script>x()</script>",
          posted_by: '"><a href="https://evil.example">',
          url: 'https://jobs.example.com/?q="><script>',
        }),
      ],
      site: ORIGIN, unsubscribeUrl: UNSUB,
    });
    for (const raw of ["<img", "<b>", "<i>", "<script>", "evil.example\">", 'q="><']) expect(mail.html).not.toContain(raw);
    expect(mail.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(mail.html).toContain("Tom &amp; Jerry&#39;s");
    expect(mail.html).toContain("&lt;/p&gt;&lt;script&gt;x()&lt;/script&gt;");
  });

  it("adds List-Unsubscribe headers only for an https pause link", () => {
    const https = digestEmail({ localDate: "2026-09-12", jobs: [job()], site: ORIGIN, unsubscribeUrl: UNSUB });
    expect(https.headers).toEqual({ "List-Unsubscribe": `<${UNSUB}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
    expect(https.from).toEqual({ email: "jobs@nextcryptojob.xyz", name: "NextCryptoJob" });
    const local = digestEmail({ localDate: "2026-09-12", jobs: [job()], site: "http://localhost:3000", unsubscribeUrl: "http://localhost:3000/api/digest/unsubscribe?u=ada&t=abc" });
    expect(local.headers).toBeUndefined();
    expect(local.text).toContain("Pause daily jobs: http://localhost:3000/api/digest/unsubscribe");
  });

  it("links a company job that takes applications by email", () => {
    const mail = digestEmail({ localDate: "2026-09-12", jobs: [job({ url: "mailto:jobs@acme.io" })], site: ORIGIN, unsubscribeUrl: UNSUB });
    expect(mail.html).toContain('href="mailto:jobs@acme.io"');
  });

  it("shows a job with a non-http address without a link", () => {
    const mail = digestEmail({ localDate: "2026-09-12", jobs: [job({ url: "javascript:alert(1)" })], site: ORIGIN, unsubscribeUrl: UNSUB });
    expect(mail.html).not.toContain("javascript:");
    expect(mail.html).toContain("1. Protocol Engineer");
    expect(mail.text).not.toContain("javascript:");
  });

  it("never carries a long dash from a board into the email", () => {
    const mail = digestEmail({ localDate: "2026-09-12", jobs: [job({ title: "Engineer \u2014 DeFi" })], site: ORIGIN, unsubscribeUrl: UNSUB });
    expect(mail.text).toContain("Engineer - DeFi");
    expect(mail.html).not.toContain("\u2014");
  });
});
