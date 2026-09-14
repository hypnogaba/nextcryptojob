import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { estimateText } from "@/lib/digest/format";
import * as engineJobs from "../../../../engine/src/digest/jobs";
import { estimateSourceOf, salaryEstimateOf } from "./pool";

/**
 * Оцінка зарплати від дошки (web3.career, db/jobs/0002): лише приглушений підпис «est. … (web3.career
 * estimate)», окреме поле search_jobs. Ніколи не зарплата: ні підбір, ні лічильник, ні JobPosting.
 */

const row = (o: Partial<Parameters<typeof salaryEstimateOf>[0]> = {}) => ({
  salary_min: null, salary_max: null, salary_est_min: 180_000, salary_est_max: 225_000, salary_est_currency: "USD",
  source: "board:web3career", ...o,
});

describe("board salary estimate", () => {
  it("only without an employer range, only plausible, with who made it", () => {
    expect(salaryEstimateOf(row())).toEqual({ min: 180_000, max: 225_000, currency: "USD", period: "year", by: "web3.career" });
    expect(salaryEstimateOf(row({ salary_min: 90_000 }))).toBeNull();
    expect(salaryEstimateOf(row({ salary_est_min: 900, salary_est_max: 1_000 }))).toBeNull();
    expect(salaryEstimateOf(row({ salary_est_min: null, salary_est_max: null }))).toBeNull();
    expect(estimateText(salaryEstimateOf(row()))).toBe("est. $180k to $225k (web3.career estimate)");
    expect(estimateText(salaryEstimateOf(row({ salary_est_max: null })))).toBe("est. from $180k (web3.career estimate)");
  });

  it("the same text and source name as the engine digest", () => {
    for (const source of ["board:web3career", "board:remote3", null]) expect(estimateSourceOf(source)).toBe(engineJobs.estimateSourceOf(source));
    const e = { salary: { min: 180_000, max: 225_000, currency: "USD", period: "year" as const }, by: "web3.career" };
    expect(estimateText({ ...e.salary, by: e.by })).toBe(engineJobs.estimateText(e));
  });

  it("never reaches the JobPosting markup or the salary matching code", () => {
    for (const file of ["./job-posting.ts", "./match.ts"]) {
      expect(readFileSync(new URL(file, import.meta.url), "utf8"), file).not.toMatch(/estimate|salary_est/i);
    }
  });
});
