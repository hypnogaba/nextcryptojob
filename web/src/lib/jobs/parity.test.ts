import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as engineJobs from "../../../../engine/src/digest/jobs";
import * as engineMatch from "../../../../engine/src/digest/match";
import * as engineRoles from "../../../../engine/src/digest/roles";
import { foldText, isRemoteLocation, mentionsCity } from "./nextrole-place";
import { plausibleSalary } from "@/lib/digest/format";
import { LIVE_WINDOW_DAYS, NEXTROLE_POOL_SQL, nextroleSieve, POSTED_WINDOW_DAYS } from "./nextrole-pool";
import { titleRoles } from "./nextrole-roles";

/**
 * search_jobs бере вакансії NextRole тими самими правилами, що й добірка engine
 * (T12: «same freshness window and web3 filter as engine/src/digest»). Правила
 * скопійовано в web, бо Worker сайту не збирає код engine; цей тест тримає копію
 * дослівною: зміна в engine без переносу сюди його валить.
 */

const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");
const fromFirstExport = (src: string) => src.slice(src.indexOf("\nexport "));

describe("NextRole rules in web are the engine's rules", () => {
  it("roles from the job title: the code is the same as engine/src/digest/roles.ts", () => {
    expect(fromFirstExport(read("./nextrole-roles.ts"))).toBe(fromFirstExport(read("../../../../engine/src/digest/roles.ts")));
  });

  it("non-crypto companies: the code is the same as engine/src/digest/clean.ts", () => {
    expect(fromFirstExport(read("./nextrole-clean.ts"))).toBe(fromFirstExport(read("../../../../engine/src/digest/clean.ts")));
  });

  it("matching (role, place, salary, one per company, freshness): the code is the same as engine/src/digest/match.ts", () => {
    expect(fromFirstExport(read("./nextrole-match.ts"))).toBe(fromFirstExport(read("../../../../engine/src/digest/match.ts")));
  });

  it("the same pool query and the same freshness windows", () => {
    expect(NEXTROLE_POOL_SQL).toBe(engineJobs.NEXTROLE_POOL_SQL);
    expect(LIVE_WINDOW_DAYS).toBe(engineJobs.LIVE_WINDOW_DAYS);
    expect(POSTED_WINDOW_DAYS).toBe(engineJobs.POSTED_WINDOW_DAYS);
  });

  it("the row sieve (tag, company, title) is the engine's nextroleJob up to where it builds the job", () => {
    const engine = read("../../../../engine/src/digest/jobs.ts");
    const web = read("./nextrole-pool.ts");
    const body = (src: string, head: string, end: string) => {
      const start = src.indexOf("\n", src.indexOf(head)) + 1;
      return src.slice(start, src.indexOf(end, start));
    };
    const engineSieve = body(engine, "export function nextroleJob(r: NrRow)", "  return {\n    job:");
    expect(engineSieve.trim()).not.toBe("");
    expect(body(web, "export function nextroleSieve(r: NrRow)", "  return { tags, roles };")).toBe(engineSieve);
    // tagsOf, на якому стоїть сито, теж той самий.
    const fn = (src: string) => src.slice(src.indexOf("function tagsOf("), src.indexOf("\n}\n", src.indexOf("function tagsOf(")) + 3);
    expect(fn(web)).toBe(fn(engine));
  });

  it("the sieve drops the same rows as the engine for the same reason", () => {
    const base = {
      id: "x", url: "https://boards.example.com/x", company: "Chain Labs", company_key: "chain labs", title: "Solidity Engineer",
      location: "Remote", remote: 1, salary_min: null, salary_max: null, salary_currency: null, tags: '["web3"]',
      posted_at: null, fetched_at: "2026-09-13T06:00:00Z", country: null, dedupe_key: null,
    };
    for (const r of [
      base,
      { ...base, tags: '["web3ish"]' },
      { ...base, tags: "not json" },
      { ...base, company: "Crusoe", company_key: "crusoe" },
      { ...base, title: "Head Chef" },
      { ...base, title: "Audio Transcription Engineer" },
    ]) {
      const e = engineJobs.nextroleJob(r);
      const w = nextroleSieve(r);
      expect({ title: r.title, tags: r.tags, drop: "drop" in w ? w.drop : null }).toEqual({ title: r.title, tags: r.tags, drop: "drop" in e ? e.drop : null });
    }
  });

  it("one salary range: 10k to 5M a year, monthly times 12, the same as the digest", () => {
    for (const [v, period] of [[9_999, "year"], [10_000, "year"], [5_000_000, "year"], [5_000_001, "year"], [833, "month"], [834, "month"], [416_666, "month"], [416_667, "month"]] as const) {
      const engine = engineMatch.annualRange({ min: v, max: null, currency: "USD", period }) !== null;
      expect({ v, period, ok: plausibleSalary(v, period) }).toEqual({ v, period, ok: engine });
    }
  });

  it("gives the same answers on real titles and locations", () => {
    for (const title of ["Senior Solidity Engineer", "Internal Audit Manager", "Head Chef", "Product Designer", "DevRel Lead", "Trading Analyst"]) {
      expect({ title, roles: titleRoles(title, ["web3"]) }).toEqual({ title, roles: engineRoles.titleRoles(title, ["web3"]) });
    }
    for (const [flag, location] of [[true, "New York - Hybrid"], [false, "Remote, EU"], [true, null], [false, "Berlin"]] as const) {
      expect(isRemoteLocation(flag, location)).toBe(engineMatch.isRemoteLocation(flag, location));
    }
    expect(foldText("São Paulo")).toBe(engineMatch.foldText("São Paulo"));
    expect(mentionsCity("Lisboa, Portugal", "Lisbon")).toBe(engineMatch.mentionsCity("Lisboa, Portugal", "Lisbon"));
  });
});
