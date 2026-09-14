// Перенесено з NextRole (crypto-jobs-agent, scanner): src/salary.test.ts.
import { describe, expect, it } from "vitest";
import { extractSalary } from "./salary-text.js";

describe("extractSalary", () => {
  it("вилка в доларах із комами", () => {
    expect(extractSalary("Compensation: $120,000 - $150,000 per year plus equity."))
      .toEqual({ min: 120_000, max: 150_000, currency: "USD" });
  });
  it("вилка з k і тире en-dash", () => {
    expect(extractSalary("Salary range $120k–$150k")).toEqual({ min: 120_000, max: 150_000, currency: "USD" });
  });
  it("євро з крапкою як роздільником тисяч", () => {
    expect(extractSalary("Gehalt: €60.000 – €80.000 pro Jahr")).toEqual({ min: 60_000, max: 80_000, currency: "EUR" });
  });
  it("одиночна сума: підлога", () => {
    expect(extractSalary("Base salary £70,000 per annum")).toEqual({ min: 70_000, max: null, currency: "GBP" });
  });
  it("«up to»: стеля", () => {
    expect(extractSalary("Up to $150,000 depending on experience")).toEqual({ min: null, max: 150_000, currency: "USD" });
  });
  it("код валюти перед числом і після", () => {
    expect(extractSalary("USD 90,000")).toEqual({ min: 90_000, max: null, currency: "USD" });
    expect(extractSalary("Salaire : 90 000 EUR brut annuel")).toEqual({ min: 90_000, max: null, currency: "EUR" });
  });
  it("k на другому числі стосується обох", () => {
    expect(extractSalary("60k-80k EUR")).toEqual({ min: 60_000, max: 80_000, currency: "EUR" });
    expect(extractSalary("$60-80k")).toEqual({ min: 60_000, max: 80_000, currency: "USD" });
  });
  it("«to» і «between … and» як роздільники", () => {
    expect(extractSalary("between $100,000 and $130,000")).toEqual({ min: 100_000, max: 130_000, currency: "USD" });
    expect(extractSalary("$100,000 to $130,000/yr")).toEqual({ min: 100_000, max: 130_000, currency: "USD" });
  });
  it("місячна сума множиться на 12", () => {
    expect(extractSalary("€4,000 – €5,000 per month")).toEqual({ min: 48_000, max: 60_000, currency: "EUR" });
    expect(extractSalary("Зарплата 80 000 – 120 000 грн в місяць")).toEqual({ min: 960_000, max: 1_440_000, currency: "UAH" });
    expect(extractSalary("3 000 € par mois")).toEqual({ min: 36_000, max: null, currency: "EUR" });
  });
  it("годинну ставку не бере", () => {
    expect(extractSalary("$45 - $60 per hour")).toBeNull();
    expect(extractSalary("Pay: $35/hour")).toBeNull();
  });
  it("роки, 401(k), відсотки й equity не зарплата", () => {
    expect(extractSalary("Founded in 2019, growing 2024-2026. 401(k) match up to 4%.")).toBeNull();
    expect(extractSalary("Equity: 0.1% - 0.5%")).toBeNull();
    expect(extractSalary("5+ years of experience, 24/7 on-call")).toBeNull();
  });
  it("бонуси й інвестиційні раунди не зарплата", () => {
    expect(extractSalary("We raised $50M Series B. $5,000 sign-on bonus.")).toBeNull();
    expect(extractSalary("$2,000 learning budget")).toBeNull();
  });
  it("вилка важливіша за одиночну суму, навіть пізнішу", () => {
    expect(extractSalary("$1,500 stipend. Base: $100,000 - $120,000 USD."))
      .toEqual({ min: 100_000, max: 120_000, currency: "USD" });
  });
  it("порожній текст і текст без чисел", () => {
    expect(extractSalary(null)).toBeNull();
    expect(extractSalary("You will own the trade lifecycle.")).toBeNull();
  });
});
