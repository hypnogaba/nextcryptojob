// Підбір за рівнем і регіоном (B5, аудит 29.09): перевіряємо поведінку, а не сталі.
import { describe, expect, it } from "vitest";
import { fitsRestriction, parseRestriction, parseWindow, personGeo } from "./geo.js";
import { fitLine } from "./fit.js";
import {
  type DigestJob, type DigestProfile, jobSeniority, levelOfScores, personLevel, selectJobs,
} from "./match.js";

const NOW = new Date("2026-09-12T10:00:00Z");
const daysAgo = (d: number) => NOW.getTime() - d * 86_400_000;

let seq = 0;
function job(p: Partial<DigestJob> = {}): DigestJob {
  seq++;
  const id = `b${seq}`;
  return {
    ref: `nr:${id}`, source: "nextrole", id, title: p.title ?? "Solidity Engineer", company: `Co ${seq}`, companyKey: `co ${seq}`,
    url: `https://jobs.example/${id}`, location: p.location ?? "Remote", placeText: p.placeText ?? p.location ?? "Remote",
    remote: p.remote ?? true, country: null, salary: null, postedAt: p.postedAt ?? daysAgo(2), firstSeenAt: null, seenAt: daysAgo(1),
    dedupeKey: null, roles: ["engineer"],
  };
}
const profile = (p: Partial<DigestProfile> = {}): DigestProfile => ({
  roles: ["engineer"], remoteMode: "remote", city: null, salaryMin: null, salaryCurrency: null, ...p,
});
const pick = (crawl: DigestJob[], prof: DigestProfile) => selectJobs({ crawl, company: [] }, prof, { now: NOW, exclude: new Set() });
const titles = (crawl: DigestJob[], prof: DigestProfile) => pick(crawl, prof).map((p) => p.job.title);

describe("рівень вакансії з назви", () => {
  it.each([
    ["Software Engineering Intern", 0], ["Junior Solidity Developer", 1], ["Mid-level Backend Engineer", 2], ["Sr. Rust Engineer", 3],
    ["Staff Engineer", 4], ["Principal Security Researcher", 4], ["Tech Lead", 5], ["Head of Growth", 5],
    ["Director of Engineering", 6], ["VP Marketing", 6], ["Senior Director, Partnerships", 6], ["Chief Technology Officer", 6],
  ])("%s -> %i", (title, rank) => expect(jobSeniority(title)).toBe(rank));

  it("назва без рівня: невідомо, а не mid", () => expect(jobSeniority("Solidity Engineer")).toBeNull());
});

describe("рівень людини", () => {
  it("її слова переважають бал", () => {
    expect(personLevel({ roleText: "Senior smart contract dev", scoreLevel: 1 })).toEqual({ lo: 3, hi: 3 });
    expect(personLevel({ targetText: "looking for senior or lead roles", scoreLevel: 2 })).toEqual({ lo: 3, hi: 5 });
  });
  it("роки досвіду", () => {
    expect(personLevel({ targetText: "I have 8 years of experience" })).toEqual({ lo: 3, hi: 3 });
    expect(personLevel({ targetText: "1 year in web3" })).toEqual({ lo: 1, hi: 1 });
  });
  it("без слів іде рівень картки; без балу невідомо", () => {
    expect(personLevel({ scoreLevel: 1 })).toEqual({ lo: 0, hi: 2 });
    expect(personLevel({ scoreLevel: 9 })).toEqual({ lo: 3, hi: 6 });
    expect(personLevel({})).toBeNull();
    expect(levelOfScores({ engineer: 72, trader: 15 })).toBe(8);
    expect(levelOfScores({})).toBeNull();
  });
});

describe("selectJobs: м'який штраф за рівень", () => {
  const junior = job({ title: "Junior Solidity Engineer" });
  const head = job({ title: "Head of Engineering" });
  const plain = job({ title: "Solidity Engineer" });

  it("джуну голова відділу йде нижче, але нікуди не зникає", () => {
    const out = titles([head, junior, plain], profile({ roleText: "junior developer" }));
    expect(out[out.length - 1]).toBe("Head of Engineering");
    expect(out).toHaveLength(3);
  });

  it("лід бачить ту саму пару вакансій в іншому порядку", () => {
    const out = titles([junior, head, plain], profile({ targetText: "lead roles" }));
    expect(out[out.length - 1]).toBe("Junior Solidity Engineer");
  });

  it("єдина вакансія з розбіжністю все одно йде людині", () => {
    expect(titles([head], profile({ roleText: "junior" }))).toEqual(["Head of Engineering"]);
  });

  it("рівень невідомий з будь-якого боку: порядок не міняється", () => {
    const a = job({ title: "Head of Engineering", postedAt: daysAgo(1) });
    const b = job({ title: "Junior Solidity Engineer", postedAt: daysAgo(3) });
    expect(titles([b, a], profile())).toEqual(["Head of Engineering", "Junior Solidity Engineer"]);
    const noLevel = profile({ roleText: "smart contracts" });
    expect(titles([b, a], noLevel)).toEqual(["Head of Engineering", "Junior Solidity Engineer"]);
  });

  it("причина «рівень підходить» з'являється, коли назва каже рівень і він у вікні", () => {
    const [p] = pick([job({ title: "Senior Solidity Engineer" })], profile({ scoreLevel: 5 }));
    expect(p!.levelFit).toBe(true);
    expect(fitLine(p!, profile({ scoreLevel: 5 }), { words: null, scores: {} }, NOW)).toContain("The level fits you.");
    const [q] = pick([job({ title: "Solidity Engineer" })], profile({ scoreLevel: 5 }));
    expect(q!.levelFit).toBeUndefined();
  });
});

describe("geo: обмеження віддаленої вакансії", () => {
  const eu = personGeo("Europe/Paris", null, NOW);
  const us = personGeo("America/Chicago", null, NOW);
  const unknown = personGeo("UTC", null, NOW);

  it("людина за поясом", () => {
    expect(eu).toMatchObject({ country: "FR", region: "EU" });
    expect(us).toMatchObject({ country: "US", region: "NA", offsetHours: -5 });
    expect(personGeo("Asia/Kolkata", null, NOW).offsetHours).toBe(5.5);
    expect(unknown).toEqual({ country: null, region: null, offsetHours: null });
    expect(personGeo("Not/AZone", null, NOW).country).toBeNull();
    expect(personGeo("Europe/Paris", "Toronto, Canada", NOW).country).toBe("CA");
  });

  const verdict = (location: string, who = eu, title?: string) => {
    const r = parseRestriction(location, title);
    return r === null ? "open" : fitsRestriction(r, who);
  };

  it.each([
    ["Remote (US only)", false], ["Remote - USA", false], ["Remote, United States", false], ["US Remote", false],
    ["Remote - Americas", false], ["North America", false], ["Remote (LATAM)", false], ["Remote, Canada", false],
    ["Remote - EMEA", true], ["Remote, Europe only", true], ["Remote (EU)", true], ["Remote, UK", false], ["Remote - APAC", false],
    ["Must be based in Germany", false], ["Must be based in France", true],
    ["Remote (UTC-3 to UTC+2)", true], ["GMT+5 - GMT+9", false], ["Remote, UTC±2", true], ["Remote, UTC±1", false],
  ])("%s для людини з Парижа: %s", (location, fits) => expect(verdict(location)).toBe(fits));

  it("без обмеження: відкрито", () => {
    for (const loc of ["Remote", "Worldwide", "Remote, Global (US preferred)", "Anywhere", "Remote - Work from anywhere"]) {
      expect(verdict(loc)).toBe("open");
    }
  });

  it("людина з США", () => {
    expect(verdict("Remote (US only)", us)).toBe(true);
    expect(verdict("Remote - Americas", us)).toBe(true);
    expect(verdict("Remote - EMEA", us)).toBe(false);
    expect(verdict("Remote (UTC+1 to UTC+3)", us)).toBe(false);
  });

  it("людина з невпізнаним поясом: не знаємо, а не «ні»", () => {
    expect(verdict("Remote (US only)", unknown)).toBeNull();
  });

  it("обмеження в назві лише коли воно сказане прямо", () => {
    expect(verdict("Remote", eu, "Engineer (US only)")).toBe(false);
    expect(verdict("Remote", eu, "US Treasury Analyst")).toBe("open");
  });

  it("вікно поясів у різних записах", () => {
    expect(parseWindow("UTC-3 to UTC+2")).toEqual({ lo: -3, hi: 2 });
    expect(parseWindow("within 3 hours of UTC+1")).toEqual({ lo: -2, hi: 4 });
    expect(parseWindow("+/- 2 hours of GMT+8")).toEqual({ lo: 6, hi: 10 });
    expect(parseWindow("Remote")).toBeNull();
  });
});

describe("selectJobs: регіон людини й віддалені вакансії", () => {
  const usOnly = job({ title: "Backend Engineer", location: "Remote (US only)" });
  const emea = job({ title: "Rust Engineer", location: "Remote - EMEA" });
  const open = job({ title: "Go Engineer", location: "Remote" });

  it("людина з Європи не отримує «US only», а EMEA й відкриті отримує", () => {
    const out = titles([usOnly, emea, open], profile({ timezone: "Europe/Berlin" }));
    expect(out.sort()).toEqual(["Go Engineer", "Rust Engineer"]);
  });

  it("невідомий пояс: жодної вакансії не втрачено, але з обмеженням нижче за відкриті", () => {
    const out = titles([usOnly, open], profile({ timezone: null }));
    expect(out).toEqual(["Go Engineer", "Backend Engineer"]);
  });

  it("людина зі США бачить «US only»", () => {
    expect(titles([usOnly], profile({ timezone: "America/New_York" }))).toEqual(["Backend Engineer"]);
  });
});

describe("selectJobs: місто і країна", () => {
  const texas = job({ title: "Backend Engineer", location: "Paris, Texas, United States", placeText: "Paris, Texas, United States", remote: false });
  const france = job({ title: "Rust Engineer", location: "Paris, France", placeText: "Paris, France", remote: false });
  const bare = job({ title: "Go Engineer", location: "Paris", placeText: "Paris", remote: false });
  const city = (tz: string | null) => profile({ remoteMode: "city", city: "Paris", timezone: tz });

  it("Paris з Європи не збігається з Paris, Texas", () => {
    expect(titles([texas, france, bare], city("Europe/Paris")).sort()).toEqual(["Go Engineer", "Rust Engineer"]);
  });

  it("людина з Техасу отримує Paris, Texas і не отримує Paris, France", () => {
    expect(titles([texas, france], city("America/Chicago"))).toEqual(["Backend Engineer"]);
  });

  it("країна людини невідома: перевірити нічим, беремо як раніше", () => {
    expect(titles([texas, france], city(null)).sort()).toEqual(["Backend Engineer", "Rust Engineer"]);
  });

  it("країна дописана до міста людини працює без пояса", () => {
    const p = profile({ remoteMode: "city", city: "Paris, France", timezone: null });
    expect(titles([texas, france], p)).toEqual(["Rust Engineer"]);
  });
});
