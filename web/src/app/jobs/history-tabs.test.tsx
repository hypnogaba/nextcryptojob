import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SentDigest, SentJob } from "@/lib/digest/history";
import { HistoryTabs } from "./history-tabs";

function job(ref: string, title: string): SentJob {
  return {
    ref,
    source: "nextrole",
    why: "Matches your role.",
    state: "ok",
    details: { title, company: "Acme", location: "Remote", salary: null, url: "https://example.com/job", postedBy: null },
  };
}

function digest(id: string, localDate: string, jobs: SentJob[]): SentDigest {
  return { digestId: id, localDate, channel: "email", jobs };
}

describe("HistoryTabs (item 16)", () => {
  it("opens on Today when today has jobs, and shows only today's digest there", () => {
    const digests = [digest("dg1", "2026-09-15", [job("nr:a", "Solidity Engineer")]), digest("dg2", "2026-09-10", [job("nr:b", "BD Lead")])];
    const html = renderToStaticMarkup(<HistoryTabs digests={digests} savedRefs={[]} todayLocalDate="2026-09-15" />);
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Solidity Engineer");
    expect(html).not.toContain("BD Lead");
  });

  it("falls back to Earlier when nothing was sent today, instead of an empty Today", () => {
    const digests = [digest("dg2", "2026-09-10", [job("nr:b", "BD Lead")])];
    const html = renderToStaticMarkup(<HistoryTabs digests={digests} savedRefs={[]} todayLocalDate="2026-09-15" />);
    expect(html).toContain("BD Lead");
  });

  it("marks a saved job's button as saved, with no Saved tab (saved jobs have their own list)", () => {
    const digests = [digest("dg1", "2026-09-15", [job("nr:a", "Solidity Engineer"), job("nr:b", "BD Lead")])];
    const html = renderToStaticMarkup(<HistoryTabs digests={digests} savedRefs={["nr:a"]} todayLocalDate="2026-09-15" />);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html.match(/role="tab"/g)).toHaveLength(2);
  });

  it("says so when there is nothing sent at all", () => {
    const html = renderToStaticMarkup(<HistoryTabs digests={[]} savedRefs={[]} todayLocalDate="2026-09-15" />);
    expect(html).toContain("Nothing sent today yet.");
  });
});
