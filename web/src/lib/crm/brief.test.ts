import { describe, expect, it } from "vitest";
import { briefFilters, briefFromJob, briefFromParams, briefFromText, briefQuery, chainsOf, fitReasons } from "./brief";
import { paramsFromQuery } from "./search-params";
import type { CandidateSummary } from "./types";

const SOLANA_JOB = `Senior Rust Engineer
We build a perp DEX on Solana. Fully remote, any time zone.
You will write Anchor programs and keep our database fast. Competitive base salary.`;

function candidate(over: Partial<CandidateSummary> = {}): CandidateSummary {
  return {
    candidate_id: "cand_1",
    visibility: "visible",
    label: "C-1",
    headline: { role: "engineer", score: 78, level: 8, coverage: 80, unscored_reason: null },
    roles: [{ role: "engineer", score: 78, level: 8, coverage: 80, unscored_reason: null }],
    work: { modes: ["remote"], city: null },
    salary_floor: null,
    chains: ["solana"],
    onchain_years: 4,
    badges: { x_verified: true, wallet: "none" },
    contact_mode: "approval",
    pipeline: null,
    ...over,
  } as CandidateSummary;
}

describe("brief from pasted text", () => {
  it("reads the role from the title, remote, and chains named in the text", () => {
    const b = briefFromText(SOLANA_JOB);
    expect(b.roles[0]).toBe("engineer");
    expect(b.confident).toBe(true);
    expect(b.work).toBe("remote");
    expect(b.chains).toEqual(["solana"]);
  });

  it("does not read Base from base salary, codebase or database", () => {
    expect(chainsOf("Competitive base salary. Own the codebase and the database.")).toEqual([]);
    expect(chainsOf("We are live on Base and Arbitrum")).toEqual(["base", "arbitrum"]);
  });

  it("leaves the place open when the text says remote or hybrid", () => {
    expect(briefFromText("BD Lead\nRemote or hybrid in Lisbon").work).toBeNull();
  });

  it("finds a BD role and not an engineer in 'business developer'", () => {
    expect(briefFromText("Business Developer, DeFi partnerships").roles[0]).toBe("bd");
  });

  it("gives an unsure guess for text with no clear role", () => {
    const b = briefFromText("We need someone great to help us grow");
    expect(b.confident).toBe(false);
  });
});

describe("brief from a company job", () => {
  it("uses the job's roles, city and salary per year", () => {
    const b = briefFromJob({
      title: "Community Manager",
      description: "Grow our Hyperliquid community",
      roles: ["community"],
      work_mode: ["city"],
      city: "Lisbon",
      salary: { min: 4000, max: 6000, currency: "USD", period: "month" },
    });
    expect(b).toMatchObject({ roles: ["community"], work: "city", city: "Lisbon", chains: ["hyperliquid"] });
    expect(b.salaryMaxYear).toEqual({ amount: 72000, currency: "USD" });
    expect(briefFilters(b, "community")).toEqual({ role: "community", exclude_in_pipeline: true, work_mode: "city", city: "Lisbon" });
  });

  it("does not filter by place when the job is remote or city", () => {
    const b = briefFromJob({ title: "Trader", roles: ["trader"], work_mode: ["remote", "city"], city: "Dubai", salary: null } as const);
    expect(b.work).toBeNull();
    expect(briefFilters(b, "trader")).toEqual({ role: "trader", exclude_in_pipeline: true });
  });
});

describe("brief in the page address", () => {
  it("round-trips without the text itself", () => {
    const b = briefFromText(SOLANA_JOB);
    const query = briefQuery(b, undefined, "job_1");
    expect(query).not.toContain("Anchor");
    const back = briefFromParams(paramsFromQuery(query));
    expect(back.role).toBe("engineer");
    expect(back.brief).toEqual(b);
  });

  it("drops unknown roles and chains", () => {
    const { role, brief } = briefFromParams(paramsFromQuery("role=pirate&roles=pirate,bd&chains=doge,base&salary=1e9USD"));
    expect(role).toBe("bd");
    expect(brief.chains).toEqual(["base"]);
    expect(brief.salaryMaxYear).toBeNull();
  });
});

describe("why they fit", () => {
  const brief = { ...briefFromText(SOLANA_JOB), salaryMaxYear: { amount: 150000, currency: "USD" } };

  it("names the score, remote, a shared chain and a salary that fits", () => {
    const reasons = fitReasons(candidate({ salary_floor: { amount: 120000, currency: "USD" } }), brief, "engineer");
    expect(reasons[0]).toMatch(/score 78, level 8/);
    expect(reasons).toContain("Wants remote");
    expect(reasons).toContain("Active on Solana");
    expect(reasons.some((r) => r.includes("fits your range"))).toBe(true);
  });

  it("says when the salary floor is above the range", () => {
    const reasons = fitReasons(candidate({ salary_floor: { amount: 200000, currency: "USD" } }), brief, "engineer");
    expect(reasons.some((r) => r.includes("above your range"))).toBe(true);
  });

  it("does not claim a chain the candidate is not on", () => {
    expect(fitReasons(candidate({ chains: ["ethereum"] }), brief, "engineer")).not.toContain("Active on Solana");
  });
});
