import { beforeEach, describe, expect, it } from "vitest";
import { migratedD1, type TestDb } from "@/test/sqlite-d1";
import { parsePlace, parseSalary, placeFromText, whereFromMode } from "./place";
import { finishOnboarding, loadAnswers, placeFields, rolesFields, saveStep, targetFields } from "./store";
import { advance, briefDone, canVisit, nextStep, parseSavedStep, prevStep, stepPosition, stepToShow } from "./steps";

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
    // Після останнього кроку анкети (умови) досягнуто перший крок «Stand out», після джерел усе.
    expect(advance("delivery", "delivery")).toBe("x");
    expect(advance("sources", "sources")).toBe("done");
    expect(advance("done", "x")).toBe("done");
  });
});

describe("brief first, stand out after", () => {
  it("asks what, roles, where and how to send (no consent step), then the optional X, wallets and sources", () => {
    const order: string[] = [];
    for (let s = parseSavedStep(null); s !== "done"; s = nextStep(s)) order.push(s);
    expect(order).toEqual(["target", "roles", "place", "delivery", "x", "wallets", "sources"]);
  });

  it("reads the old consent step saved in the database as delivery", () => {
    expect(parseSavedStep("consent")).toBe("delivery");
  });

  it("counts steps in their own part and does not go back from stand out into the brief", () => {
    expect(stepPosition("delivery")).toEqual({ part: "brief", n: 4, of: 4 });
    expect(stepPosition("wallets")).toEqual({ part: "standout", n: 2, of: 3 });
    expect(prevStep("x")).toBeNull();
    expect(prevStep("sources")).toBe("wallets");
    expect(prevStep("roles")).toBe("target");
  });

  it("the brief is done once the last button moves a person to the stand out steps", () => {
    expect(briefDone("delivery")).toBe(false);
    expect(briefDone("x")).toBe(true);
    expect(briefDone("done")).toBe(true);
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

  it("does not take inherited object keys as a choice", () => {
    for (const where of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(parsePlace({ where, city: "", salary: "", currency: "USD" })).toMatchObject({
        ok: false,
        errors: { where: expect.any(String) },
      });
    }
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
      roleText: "",
      remoteMode: "remote",
      city: null,
      salaryMin: 100000,
      salaryCurrency: "USD",
      step: "delivery",
    });
    await finishOnboarding(t.d1, "a");
    expect((await loadAnswers(t.d1, "a")).step).toBe("done");
  });

  it("a stand out step without the terms (saved under the old order) resumes at the brief", async () => {
    t.raw.exec("UPDATE users SET onboarding_step = 'wallets' WHERE id = 'a'");
    expect((await loadAnswers(t.d1, "a")).step).toBe("delivery");
    t.raw.exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('a', 'terms', 1, 'terms-0.2')");
    expect((await loadAnswers(t.d1, "a")).step).toBe("wallets");
    // Стара згода на бал теж рахується.
    t.raw.exec("UPDATE consents SET kind = 'scoring' WHERE user_id = 'a'");
    expect((await loadAnswers(t.d1, "a")).step).toBe("wallets");
  });
});

describe("placeFromText: remote and pay from the words of step 1", () => {
  it("takes remote and a monthly salary as a yearly one", () => {
    expect(placeFromText("BD lead at a DeFi protocol, remote, from 3,000 EUR a month, I closed 20+ partnerships")).toEqual({
      where: "remote",
      salary: 36_000,
      currency: "EUR",
    });
    expect(placeFromText("Solidity engineer, remote or Lisbon, from $90k a year")).toEqual({ where: "remote", salary: 90_000, currency: "USD" });
    expect(placeFromText("from €2.5k per month")).toEqual({ where: null, salary: 30_000, currency: "EUR" });
    expect(placeFromText("3.000 € monthly")).toEqual({ where: null, salary: 36_000, currency: "EUR" });
    expect(placeFromText("віддалено, від 2000 доларів на місяць")).toEqual({ where: "remote", salary: 24_000, currency: "USD" });
  });

  it("takes a bare number as a salary in dollars, the way people write it", () => {
    expect(placeFromText("community manager in Paris, 120000")).toEqual({ where: null, salary: 120_000, currency: "USD" });
    expect(placeFromText("remote devrel, 90k")).toEqual({ where: "remote", salary: 90_000, currency: "USD" });
    expect(placeFromText("від 120 000 на рік")).toEqual({ where: null, salary: 120_000, currency: "USD" });
    expect(placeFromText("from 4000 a month")).toEqual({ where: null, salary: 48_000, currency: "USD" });
  });

  it("does not read a counter, a year or an age as a salary, and no city is read", () => {
    expect(placeFromText("I closed 20+ partnerships in 2024")).toEqual({ where: null, salary: null, currency: null });
    expect(placeFromText("Engineer in Lisbon")).toEqual({ where: null, salary: null, currency: null });
    expect(placeFromText("tip me $5")).toEqual({ where: null, salary: null, currency: null });
    expect(placeFromText("5 years in crypto, 30000 followers on X")).toEqual({ where: null, salary: null, currency: null });
    expect(placeFromText("I am 34 and shipped 12 projects")).toEqual({ where: null, salary: null, currency: null });
  });
});
