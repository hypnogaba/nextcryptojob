import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Layers, SourceParts, WeightsTable } from "./weights";

const cellsOf = (html: string, label: string) => {
  const row = html.slice(html.indexOf(`>${label}<`));
  return [...row.slice(0, row.indexOf("</tr>")).matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));
};

describe("weights on /scoring (v8)", () => {
  it("shows the Work points of every role, with the Onchain column", () => {
    const html = renderToStaticMarkup(<WeightsTable />);
    // 16 рядків: 15 ролей, аудитор двома шляхами.
    expect(html.match(/<th scope="row"/g)).toHaveLength(16);
    expect(html).toContain(">Onchain</th>");
    // gh_eng, gh_builder, x, media, output, onchain, trading, site, audits, links, best
    const no = "·not used";
    expect(cellsOf(html, "Trader")).toEqual([no, no, no, no, no, "10", "50", no, no, no, no]);
    expect(cellsOf(html, "Designer")).toEqual([no, no, "20", no, no, no, no, no, no, "40", no]);
    expect(html).toContain("Security auditor, with audit contests");
    expect(html).toContain("out of 60");
  });

  it("names the three layers with their points", () => {
    const html = renderToStaticMarkup(<Layers />);
    expect(html).toMatch(/Work.*60/);
    expect(html).toMatch(/Reputation.*25/);
    expect(html).toMatch(/Breadth.*20/);
    expect(html).toContain("Every other source you connect");
  });

  it("lists what each source counts, onchain first, with team work and links", () => {
    const html = renderToStaticMarkup(<SourceParts />);
    expect(html.indexOf(">Onchain</h3>")).toBeLessThan(html.indexOf(">GitHub</h3>"));
    expect(html).toContain("Wallet age");
    expect(html).toContain("commits to your team&#x27;s repos");
    expect(html).toContain("Links to your work you add yourself (not checked)");
    expect(html).toContain("Whichever of your sources scores highest.");
  });
});
