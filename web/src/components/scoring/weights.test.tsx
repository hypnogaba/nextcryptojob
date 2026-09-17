import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SourceParts, WeightsTable } from "./weights";

describe("weights on /scoring", () => {
  it("shows each role's main part and bonus, with the Onchain column", () => {
    const html = renderToStaticMarkup(<WeightsTable />);
    // Одинадцять рядків: десять ролей, аудитор двома шляхами.
    expect(html.match(/<th scope="row"/g)).toHaveLength(11);
    expect(html).toContain(">Onchain</th>");
    const trader = html.slice(html.indexOf(">Trader<"));
    const cells = [...trader.slice(0, trader.indexOf("</tr>")).matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((m) => m[1]!.replace(/<[^>]+>/g, ""));
    // gh_eng, gh_builder, x, media, output, onchain, trading, site, audits
    expect(cells).toEqual(["·not used", "·not used", "+5", "·not used", "·not used", "10", "90", "+5", "·not used"]);
    expect(html).toContain("Security auditor, with audit contests");
  });

  it("lists what each source counts, onchain first", () => {
    const html = renderToStaticMarkup(<SourceParts />);
    expect(html.indexOf(">Onchain</h3>")).toBeLessThan(html.indexOf(">GitHub</h3>"));
    expect(html).toContain("Wallet age");
    expect(html).toContain("Full at 6 years, even steps");
    expect(html).toContain("The higher of your X and YouTube scores.");
  });
});
