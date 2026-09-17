// Перенесено з попереднього проєкту (сканер): src/pay.test.ts (без Getro: вакансій з Getro тут немає).
import { describe, expect, it } from "vitest";
import { ashbyPay, currencyCode, greenhousePay, leverPay, payFor, payPeriod, plausibleSalary, yearly } from "./pay.js";

/**
 * Назви періодів тут не вигадані: кожна знята з живих відповідей 13.09.2026
 * (Greenhouse Coinbase і Ripple, Ashby Kraken/Circle/Uniswap, Lever Crypto.com).
 * Реальні відповіді цілком лежать у sources/fixtures і перевіряються в
 * sources/sources.test.ts.
 */
describe("payPeriod: слово джерела, а не величина суми", () => {
  it.each([
    ["Annual base salary range (excluding equity and bonus):", "year"],
    ["NY Annual Base Salary Range", "year"],
    ["US pay range (not including bonus, equity or other benefits)", null],
    ["Hourly Rate:", "hour"],
    ["per-year-salary", "year"],
    ["per-month-salary", "month"],
    ["per-hour-wage", "hour"],
    ["1 YEAR", "year"],
    ["1 HOUR", "hour"],
    ["year", "year"],
    ["month", "month"],
    ["period_not_defined", null],
    ["", null],
  ])("«%s» → %s", (text, want) => expect(payPeriod(text)).toBe(want));
});

describe("yearly: у кеші лише річні числа", () => {
  it("погодинна ставка множиться на 2080 годин, як у speedrun", () => {
    expect(yearly(40, "hour")).toBe(83_200);
  });
  it("місячна множиться на 12", () => expect(yearly(5_000, "month")).toBe(60_000));
  it("невідомий період лишає суму як річну", () => expect(yearly(120_000, null)).toBe(120_000));
  it("«раз на два тижні» у Ashby: 26 виплат, а не 52", () => expect(yearly(4_000, "week", 2)).toBe(104_000));
  it("неправдоподібне відкидається, а не пишеться", () => {
    expect(yearly(24, null)).toBeNull();
    expect(yearly(25_000_000, "year")).toBeNull();
    expect(yearly(0, "year")).toBeNull();
    expect(yearly(null, "year")).toBeNull();
  });
});

describe("currencyCode", () => {
  it("приводить до трьох великих літер", () => expect(currencyCode(" usd ")).toBe("USD"));
  it("не код не приймає", () => {
    expect(currencyCode("$")).toBeNull();
    expect(currencyCode(null)).toBeNull();
  });
});

describe("greenhousePay", () => {
  it("річний діапазон у центах", () => {
    expect(greenhousePay([{ min_cents: 16634500, max_cents: 19570000, currency_type: "USD",
      title: "Annual base salary range (excluding equity and bonus):" }]))
      .toEqual({ salaryMin: 166_345, salaryMax: 195_700, salaryCurrency: "USD" });
  });
  it("«Hourly Rate:» стає річною", () => {
    expect(greenhousePay([{ min_cents: 4000, max_cents: 4000, currency_type: "USD", title: "Hourly Rate:" }]))
      .toEqual({ salaryMin: 83_200, salaryMax: 83_200, salaryCurrency: "USD" });
  });
  it("«Base Salary» з «$1,925 per week» у поясненні: тиждень, а не рік (Astranis)", () => {
    expect(greenhousePay([{ min_cents: 192500, max_cents: 192500, currency_type: "USD", title: "Base Salary",
      blurb: "<p>The base salary for this position is $1,925 per week.</p>" }]).salaryMin).toBe(100_100);
  });
  it("без періоду місячна сума не стає річною (Wolt, «Poland Pay Range»)", () => {
    expect(greenhousePay([{ min_cents: 1115000, max_cents: 1393800, currency_type: "PLN", title: "Poland Pay Range",
      blurb: "The successful candidate's starting pay will fall within the pay range listed below" }]))
      .toEqual({ salaryMin: null, salaryMax: null, salaryCurrency: null });
  });
  it("без періоду правдоподібна річна лишається", () => {
    expect(greenhousePay([{ min_cents: 15000000, max_cents: 20000000, currency_type: "USD",
      title: "US pay range (not including bonus, equity or other benefits)" }]).salaryMin).toBe(150_000);
  });
  it("період у поясненні, коли назва мовчить", () => {
    expect(greenhousePay([{ min_cents: 3000, max_cents: 3500, currency_type: "USD", title: "Pay range",
      blurb: "<p>the target hourly rate for this position</p>" }]).salaryMin).toBe(62_400);
  });
  it("порожній список: порожня вилка", () => {
    expect(greenhousePay([])).toEqual({ salaryMin: null, salaryMax: null, salaryCurrency: null });
    expect(greenhousePay(undefined).salaryMin).toBeNull();
  });
});

describe("ashbyPay", () => {
  it("бере саме Salary, а не бонус чи частку", () => {
    expect(ashbyPay({ summaryComponents: [
      { compensationType: "EquityPercentage", interval: "NONE", currencyCode: null, minValue: null, maxValue: null },
      { compensationType: "Bonus", interval: "1 YEAR", currencyCode: "USD", minValue: 50_000, maxValue: 90_000 },
      { compensationType: "Salary", interval: "1 YEAR", currencyCode: "USD", minValue: 83_400, maxValue: 166_800 },
    ] })).toEqual({ salaryMin: 83_400, salaryMax: 166_800, salaryCurrency: "USD" });
  });
  it("погодинна Salary переводиться в річну", () => {
    expect(ashbyPay({ summaryComponents: [
      { compensationType: "Salary", interval: "1 HOUR", currencyCode: "USD", minValue: 50, maxValue: 60 }] }))
      .toEqual({ salaryMin: 104_000, salaryMax: 124_800, salaryCurrency: "USD" });
  });
  it("без Salary: нічого", () => {
    expect(ashbyPay({ summaryComponents: [] }).salaryMin).toBeNull();
    expect(ashbyPay(null).salaryMin).toBeNull();
  });
});

describe("leverPay", () => {
  it("річна як є", () => {
    expect(leverPay({ min: 70_000, max: 110_000, currency: "USD", interval: "per-year-salary" }))
      .toEqual({ salaryMin: 70_000, salaryMax: 110_000, salaryCurrency: "USD" });
  });
  it("погодинна більше не зникає, а стає річною", () => {
    expect(leverPay({ min: 30, max: 40, currency: "USD", interval: "per-hour-wage" }).salaryMax).toBe(83_200);
  });
  it("разова виплата не зарплата", () => {
    expect(leverPay({ min: 5_000, max: 5_000, currency: "USD", interval: "one-time" }).salaryMin).toBeNull();
  });
});

describe("payFor і plausibleSalary: без періоду лише правдоподібна річна", () => {
  it("місячна сума без періоду не стає бідною річною", () => {
    expect(payFor(4_500, null, "EUR", null)).toEqual({ salaryMin: null, salaryMax: null, salaryCurrency: null });
  });
  it("річна без періоду лишається", () => {
    expect(payFor(120_000, 150_000, "USD", null)).toEqual({ salaryMin: 120_000, salaryMax: 150_000, salaryCurrency: "USD" });
  });
  it("поріг 10 000 EUR у будь-якій валюті", () => {
    expect(plausibleSalary(10_000, null, "EUR")).toBe(true);
    expect(plausibleSalary(9_999, null, "EUR")).toBe(false);
    expect(plausibleSalary(null, 1_000_000, "INR")).toBe(true);
  });
});
