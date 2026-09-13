import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import * as engineJobs from "../../../../engine/src/digest/jobs";
import * as engineMatch from "../../../../engine/src/digest/match";
import * as engineRoles from "../../../../engine/src/digest/roles";
import { foldText, isRemoteLocation, mentionsCity } from "./nextrole-place";
import { LIVE_WINDOW_DAYS, NEXTROLE_POOL_SQL, POSTED_WINDOW_DAYS } from "./nextrole-pool";
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

  it("remote and city: the code is the same as engine/src/digest/match.ts from foldText to isRemoteLocation", () => {
    const engine = read("../../../../engine/src/digest/match.ts");
    const start = engine.indexOf("/** Нижній регістр без діакритики");
    const end = engine.indexOf("\n}\n", engine.indexOf("export function isRemoteLocation")) + 3;
    const web = read("./nextrole-place.ts");
    expect(web.slice(web.indexOf("/** Нижній регістр без діакритики"))).toBe(engine.slice(start, end));
  });

  it("the same pool query and the same freshness windows", () => {
    expect(NEXTROLE_POOL_SQL).toBe(engineJobs.NEXTROLE_POOL_SQL);
    expect(LIVE_WINDOW_DAYS).toBe(engineJobs.LIVE_WINDOW_DAYS);
    expect(POSTED_WINDOW_DAYS).toBe(engineJobs.POSTED_WINDOW_DAYS);
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
