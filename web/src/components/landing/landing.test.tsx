import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TickerJob } from "@/lib/jobs/home-board";
import { FEED_MIN_TO_ROLL, JobFeed } from "./job-feed";
import { Odometer } from "./odometer";

const text = (html: string) => html.replace(/<[^>]+>/g, "");

describe("Odometer", () => {
  it("keeps the real number as its text, with every digit rolling up from zero", () => {
    for (const v of ["0", "7", "40", "290+", "1,200+", "12,300+"]) {
      expect(text(renderToStaticMarkup(<Odometer value={v} />))).toBe(v);
    }
    const html = renderToStaticMarkup(<Odometer value="1,200+" />);
    // Тисячі 0 до 1, сотні 0 до 2, десятки оберт до 0, одиниці два оберти до 0.
    expect([...html.matchAll(/--rows:(\d+)/g)].map((m) => Number(m[1]))).toEqual([1, 2, 10, 20]);
    // Кома й «+» не крутяться.
    expect(html).toContain("<span>,</span>");
    expect(html).toContain("<span>+</span>");
  });
});

const job = (i: number, over: Partial<TickerJob> = {}): TickerJob => ({
  ref: `nr:${i}`,
  title: `Engineer ${i}`,
  company: `Co ${i}`,
  place: "Remote",
  salary: "$100k to $120k",
  href: `https://boards.example.com/${i}`,
  external: true,
  rel: "noopener noreferrer nofollow",
  via: null,
  estimate: false,
  ...over,
});

describe("JobFeed", () => {
  it("stands still, without a copy, when there are too few jobs to fill the window", () => {
    const html = renderToStaticMarkup(<JobFeed jobs={[job(1), job(2), job(3)]} />);
    expect(html).toContain('data-moving="false"');
    expect(html.match(/<ul/g)).toHaveLength(1);
  });

  it("rolls with a copy for the loop that screen readers and the keyboard skip", () => {
    const jobs = Array.from({ length: FEED_MIN_TO_ROLL }, (_, i) => job(i + 1));
    const html = renderToStaticMarkup(<JobFeed jobs={jobs} />);
    expect(html).toContain('data-moving="true"');
    const copy = html.slice(html.indexOf('<ul aria-hidden="true">'));
    expect(copy.match(/<a /g)).toHaveLength(FEED_MIN_TO_ROLL);
    expect(copy.match(/tabindex="-1"/g)).toHaveLength(FEED_MIN_TO_ROLL);
  });

  it("renders nothing without jobs", () => {
    expect(renderToStaticMarkup(<JobFeed jobs={[]} />)).toBe("");
  });

  it("links company jobs to our own page in the same tab, and boards in a new tab without referrer", () => {
    const html = renderToStaticMarkup(<JobFeed jobs={[job(1, { href: "/jobs/job_a", external: false }), job(2)]} />);
    expect(html).toMatch(/<a[^>]*href="\/jobs\/job_a"(?![^>]*target)[^>]*>/);
    expect(html).toContain('href="https://boards.example.com/2" target="_blank" rel="noopener noreferrer nofollow"');
  });

  it("never shows a board estimate as a salary", () => {
    const html = renderToStaticMarkup(
      <JobFeed jobs={[job(1, { salary: "est. $180k to $225k (web3.career estimate)", estimate: true }), job(2)]} />,
    );
    expect(html).toContain('<span class="ncj-feed-p ncj-feed-est">Not listed</span>');
    expect(html).toContain('<span class="ncj-feed-p">$100k to $120k</span>');
  });

  it("web3.career: the exact apply_url, a followed link without noreferrer, and web3.career named as the source", () => {
    const apply = "https://web3.career/r/=cTMxEDN__U4HFyv?ref=U4HFyv&utm_source=w3c";
    const html = renderToStaticMarkup(<JobFeed jobs={[job(1, { href: apply, rel: "noopener", via: "web3.career" })]} />);
    const a = /<a [^>]*>/.exec(html)![0];
    expect(a).toContain(`href="${apply.replace(/&/g, "&amp;")}"`);
    expect(a).toContain('rel="noopener"');
    expect(a).not.toMatch(/nofollow|noreferrer|ugc|sponsored/);
    expect(a).toContain("via web3.career");
    expect(text(html)).toContain("via web3.career");
  });
});
