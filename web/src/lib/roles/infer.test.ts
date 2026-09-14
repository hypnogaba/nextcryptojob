import { describe, expect, it } from "vitest";
import { TARGET_EXAMPLES } from "@/app/welcome/steps/target-form";
import { inferRoles, MIN_WEIGHT, roleWeights } from "./infer";

describe("inferRoles: the role from the person's own words, no picker", () => {
  it("reads the owner's example as BD only, not Engineer from 'DeFi protocol'", () => {
    const text = "BD lead at a DeFi protocol, remote, from 3,000 EUR a month, I closed 20+ partnerships at X";
    expect(inferRoles(text)).toEqual(["bd"]);
    // «protocol» дає інженеру вагу 1: нижче порога, тож не пропонуємо.
    expect(roleWeights(text).get("engineer")).toBeLessThan(MIN_WEIGHT);
  });

  it("gives two roles when the person names two", () => {
    expect(inferRoles("I want BD or marketing in a L2")).toEqual(["bd", "marketing_content"]);
  });

  it("uses the job-title rules of the digest (head words, synonyms) and words people write about themselves", () => {
    expect(inferRoles("Community manager for a gaming project, I ran weekly AMAs")).toEqual(["community"]);
    expect(inferRoles("Smart contract auditor, Code4rena top 50")).toEqual(["security_auditor"]);
    expect(inferRoles("product manager for a wallet")).toEqual(["product_manager"]);
    expect(inferRoles("I'm a KOL with 20k followers, want ambassador roles")).toEqual(["creator_kol"]);
    expect(inferRoles("tokenomics research for a new L1")).toEqual(["data_research"]);
    expect(inferRoles("growth hacker, KOL campaigns")).toEqual(["marketing_content", "creator_kol"]);
  });

  it("reads Ukrainian and Russian", () => {
    expect(inferRoles("Хочу працювати трейдером у фонді")).toEqual(["trader"]);
    expect(inferRoles("Шукаю роботу менеджера з партнерств, віддалено")).toEqual(["bd"]);
    expect(inferRoles("Ищу работу разработчиком смарт-контрактов")).toEqual(["engineer"]);
  });

  it("returns nothing when nothing is clear, so the page asks instead of guessing", () => {
    expect(inferRoles("something unrelated like cooking")).toEqual([]);
    expect(inferRoles("")).toEqual([]);
    expect(inferRoles("I like data")).toEqual([]);
  });

  it("every example on step 1 gives a clear first role", () => {
    expect(TARGET_EXAMPLES.map((e) => inferRoles(e.text)[0])).toEqual(["bd", "engineer", "community"]);
  });

  it("never more than three", () => {
    expect(inferRoles("engineer, auditor, devrel, data analyst, trader, designer").length).toBe(3);
  });
});
