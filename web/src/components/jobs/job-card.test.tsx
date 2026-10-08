import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { JobCard, type CardJob } from "./job-card";

const job: CardJob = {
  title: "Protocol Engineer", company: "Tether", location: "Remote", salary: null,
  url: "https://careers.tether.io/jobs/1", postedBy: null,
};

describe("JobCard: підпис джерела", () => {
  it("ChainJobs: Apply веде до роботодавця, а «via chainjobs.io» посиланням на chainjobs.io (CC BY 4.0)", () => {
    const html = renderToStaticMarkup(<JobCard job={{ ...job, via: "chainjobs.io" }} />);
    expect(html).toContain('href="https://careers.tether.io/jobs/1"');
    expect(html).toMatch(/via <a href="https:\/\/chainjobs\.io"[^>]*>chainjobs\.io<\/a>/);
  });

  it("без джерела-агрегатора підпису немає", () => {
    expect(renderToStaticMarkup(<JobCard job={job} />)).not.toContain("via ");
  });
});
