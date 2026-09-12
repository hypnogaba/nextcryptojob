import { beforeEach, describe, expect, it } from "vitest";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import { parsePlace, parseSalary, whereFromMode } from "./place";
import { finishOnboarding, loadAnswers, placeFields, rolesFields, saveStep, targetFields } from "./store";
import { advance, canVisit, parseSavedStep, stepToShow } from "./steps";

describe("steps", () => {
  it("resumes from the saved step and starts at the beginning without one", () => {
    expect(stepToShow(undefined, parseSavedStep(null))).toBe("target");
    expect(stepToShow(undefined, parseSavedStep("wallets"))).toBe("wallets");
    expect(stepToShow(undefined, parseSavedStep("bogus"))).toBe("target");
  });

  it("lets people go back but not skip ahead", () => {
    expect(canVisit("roles", "x")).toBe(true);
    expect(canVisit("sources", "x")).toBe(false);
    expect(stepToShow("sources", "x")).toBe("x");
    expect(stepToShow("place", "x")).toBe("place");
  });

  it("opens any step once finished", () => {
    expect(stepToShow("sources", "done")).toBe("sources");
    expect(stepToShow(undefined, "done")).toBe("target");
  });

  it("only moves the saved step forward", () => {
    expect(advance("target", "target")).toBe("roles");
    expect(advance("wallets", "roles")).toBe("wallets");
    expect(advance("consent", "consent")).toBe("done");
    expect(advance("done", "x")).toBe("done");
  });
});

describe("parsePlace", () => {
  it("reads remote only, a city, or both", () => {
    expect(parsePlace({ where: "remote", city: "Lisbon", salary: "", currency: "USD" })).toEqual({
      ok: true,
      place: { remoteMode: "remote", city: null, salaryMin: null, salaryCurrency: null },
    });
    expect(parsePlace({ where: "both", city: "  Kyiv ", salary: "90k", currency: "EUR" })).toEqual({
      ok: true,
      place: { remoteMode: "remote,city", city: "Kyiv", salaryMin: 90000, salaryCurrency: "EUR" },
    });
  });

  it("asks for a city when one is chosen", () => {
    expect(parsePlace({ where: "city", city: "", salary: "", currency: "USD" })).toEqual({
      ok: false,
      errors: { city: "Enter the city." },
    });
    expect(parsePlace({ where: "city", city: "<script>", salary: "", currency: "USD" })).toMatchObject({ ok: false });
  });

  it("requires a choice and a sane salary", () => {
    expect(parsePlace({ where: undefined, city: "", salary: "lots", currency: "USD" })).toMatchObject({
      ok: false,
      errors: { where: expect.any(String), salary: expect.any(String) },
    });
  });

  it("falls back to USD for an unknown currency", () => {
    expect(parsePlace({ where: "remote", city: "", salary: "100000", currency: "BTC" })).toMatchObject({
      place: { salaryCurrency: "USD" },
    });
  });

  it("parses salaries people type", () => {
    expect(parseSalary("120 000")).toBe(120000);
    expect(parseSalary("120,000")).toBe(120000);
    expect(parseSalary("1.5k")).toBe(1500);
    expect(parseSalary("")).toBeNull();
    expect(parseSalary("-5")).toBe("invalid");
    expect(parseSalary("99999999999")).toBe("invalid");
  });

  it("maps the stored mode back to the choice", () => {
    expect(whereFromMode("remote,city")).toBe("both");
    expect(whereFromMode(null)).toBeNull();
  });
});

describe("answers store", () => {
  let t: TestDb;
  beforeEach(() => {
    t = migratedD1();
    t.raw.exec("INSERT INTO users (id, email) VALUES ('a', 'a@example.com')");
  });

  it("saves each step and resumes from the furthest one", async () => {
    let saved = (await loadAnswers(t.d1, "a")).step;
    expect(saved).toBe("target");
    saved = await saveStep(t.d1, "a", "target", targetFields("Solidity engineer"), saved);
    saved = await saveStep(t.d1, "a", "roles", rolesFields(["engineer", "security_auditor"]), saved);
    saved = await saveStep(
      t.d1,
      "a",
      "place",
      placeFields({ remoteMode: "remote", city: null, salaryMin: 100000, salaryCurrency: "USD" }),
      saved,
    );
    // Повернення назад і повторне збереження не відкочують досягнутий крок.
    saved = await saveStep(t.d1, "a", "target", targetFields("Rust engineer"), saved);
    expect(await loadAnswers(t.d1, "a")).toEqual({
      targetText: "Rust engineer",
      roles: ["engineer", "security_auditor"],
      remoteMode: "remote",
      city: null,
      salaryMin: 100000,
      salaryCurrency: "USD",
      step: "x",
    });
    await finishOnboarding(t.d1, "a");
    expect((await loadAnswers(t.d1, "a")).step).toBe("done");
  });
});
