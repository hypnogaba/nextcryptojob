import { describe, expect, it } from "vitest";
import { describeFilters, paramsFromQuery, parseSearchParams, searchQuery } from "./search-params";

describe("search filters in the page address", () => {
  it("reads the form and writes it back the same way", () => {
    const query =
      "role=engineer&min_score=60&min_level=5&max_level=10&chains=base&chains=ethereum&years=4&work=city&city=Lisbon" +
      "&x_verified=1&wallet_verified=1&contact_direct=1&hide_pipeline=1&min_coverage=50&sort=level&q=1";
    const parsed = parseSearchParams(paramsFromQuery(query));
    expect(parsed.errors).toEqual({});
    expect(parsed.run).toBe(true);
    expect(parsed.sort).toBe("level");
    expect(parsed.filters).toEqual({
      role: "engineer",
      min_score: 60,
      min_level: 5,
      max_level: 10,
      chains: ["base", "ethereum"],
      min_onchain_years: 4,
      work_mode: "city",
      city: "Lisbon",
      x_verified: true,
      wallet_verified: true,
      contact_direct: true,
      exclude_in_pipeline: true,
      min_coverage: 50,
    });
    expect(parseSearchParams(paramsFromQuery(searchQuery(parsed.filters, parsed.sort))).filters).toEqual(parsed.filters);
  });

  it("does not search until the person presses Search", () => {
    expect(parseSearchParams({ role: "engineer" }).run).toBe(false);
    expect(parseSearchParams({}).filters).toEqual({});
  });

  it("names the field that is wrong and does not search", () => {
    const parsed = parseSearchParams({ min_score: "120", min_level: "8", max_level: "3", work: "city", city: "", q: "1" });
    expect(parsed.run).toBe(false);
    expect(parsed.errors.min_score).toBe("Enter a whole number from 0 to 100.");
    expect(parseSearchParams({ work: "city", q: "1" }).errors.city).toBe("Choose a city when searching by city.");
    expect(parseSearchParams({ min_level: "8", max_level: "3", q: "1" }).errors.max_level).toBe("Max level must be at least the min level.");
    expect(parseSearchParams({ role: "wizard", q: "1" }).errors.role).toBe("Choose a role from the list.");
  });

  it("ignores unknown chains and repeated ones", () => {
    expect(parseSearchParams({ chains: ["base", "base", "dogechain"] }).filters.chains).toEqual(["base"]);
  });

  it("describes a saved search in a few words", () => {
    expect(describeFilters({ role: "engineer", min_score: 60, work_mode: "remote", chains: ["base", "solana"] })).toBe(
      "Engineer, score 60+, Base or Solana, remote, by score",
    );
    expect(describeFilters({}, "newest")).toBe("Any role, newest first");
  });
});
