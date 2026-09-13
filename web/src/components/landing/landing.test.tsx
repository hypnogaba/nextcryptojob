import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TickerJob } from "@/lib/jobs/home-board";
import { JobTicker } from "./job-ticker";
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
  ...over,
});

describe("JobTicker", () => {
  it("stands still, without a copy, when there are too few jobs to fill a wide screen", () => {
    const html = renderToStaticMarkup(<JobTicker jobs={[job(1), job(2), job(3)]} />);
    expect(html).toContain('data-moving="false"');
    expect(html.match(/<ul /g)).toHaveLength(1);
    expect(html).not.toContain("aria-hidden=\"true\"><li");
  });

  it("renders nothing without jobs", () => {
    expect(renderToStaticMarkup(<JobTicker jobs={[]} />)).toBe("");
  });

  it("links company jobs to our own page in the same tab, and boards in a new tab without referrer", () => {
    const html = renderToStaticMarkup(
      <JobTicker jobs={[job(1, { href: "/jobs/job_a", external: false }), job(2)]} />,
    );
    expect(html).toMatch(/<a[^>]*href="\/jobs\/job_a"(?![^>]*target)[^>]*>/);
    expect(html).toContain('href="https://boards.example.com/2" target="_blank" rel="noopener noreferrer nofollow"');
  });
});
