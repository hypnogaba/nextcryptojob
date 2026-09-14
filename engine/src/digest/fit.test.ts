import { describe, expect, it } from "vitest";
import { fitLine, fitNote, fitReasons, levelOf, MAX_REASONS, wordsInTitle, type FitContext, type FitPick } from "./fit.js";
import type { DigestJob, DigestProfile } from "./match.js";

const job = (p: Partial<DigestJob> = {}): DigestJob => ({
  ref: "nr:j1", source: "nextrole", id: "j1", title: "Senior Solidity Engineer", company: "Aave", companyKey: "aave",
  url: "https://jobs.example/j1", location: "Remote", placeText: "Remote", remote: true, country: null, salary: null,
  postedAt: null, firstSeenAt: null, seenAt: null, dedupeKey: null, roles: ["engineer"], ...p,
});

const profile = (p: Partial<DigestProfile> = {}): DigestProfile => ({
  roles: ["engineer"], remoteMode: "remote", city: null, salaryMin: null, salaryCurrency: null, ...p,
});

const pick = (p: Partial<FitPick> = {}): FitPick => ({ job: job(), role: "engineer", place: "remote", meetsSalary: null, ...p });
const ctx = (p: Partial<FitContext> = {}): FitContext => ({ words: null, scores: {}, ...p });

describe("wordsInTitle", () => {
  it("names the person's own words that are in the title, in title order", () => {
    expect(wordsInTitle("I want to write Solidity for a DeFi protocol", "Solidity Engineer, DeFi Protocol", "engineer"))
      .toEqual(["solidity", "defi protocol"]);
  });

  it("matches word forms: engineering and engineer, audits and auditor", () => {
    // «audits» тут слово самої ролі (Security auditor): його не називаємо.
    expect(wordsInTitle("smart contract audits", "Smart Contract Auditor", "security_auditor")).toEqual(["smart contract"]);
    expect(wordsInTitle("engineering, protocols", "Protocol Lead, Engineer Relations", "devrel")).toEqual(["protocols", "engineering"]);
    expect(wordsInTitle("backend development in rust", "Rust Engineer, Backend Developer", "engineer")).toEqual(["rust", "backend development"]);
  });

  it("words next to each other in the title read as one phrase", () => {
    expect(wordsInTitle("smart contract security, protocols", "Smart Contract Engineer, Protocols", "engineer"))
      .toEqual(["smart contract", "protocols"]);
    expect(wordsInTitle("defi solidity", "Solidity DeFi Engineer", "engineer")).toEqual(["solidity defi"]);
  });

  it("leaves out filler, level and place words, and the role's own name", () => {
    expect(wordsInTitle("senior remote engineer job in crypto", "Senior Engineer (Remote)", "engineer")).toEqual([]);
  });

  it("keeps meaningful short words and drops the rest", () => {
    expect(wordsInTitle("zk circuits, go", "ZK Engineer", "engineer")).toEqual(["zk"]);
    expect(wordsInTitle("go", "Go Engineer", "engineer")).toEqual([]);
  });

  it("no words, no match", () => {
    expect(wordsInTitle(null, "Solidity Engineer", "engineer")).toEqual([]);
    expect(wordsInTitle("", "Solidity Engineer", "engineer")).toEqual([]);
  });
});

describe("levelOf", () => {
  it("senior, entry, or nothing when both or none are said", () => {
    expect(levelOf("Senior Rust dev")).toBe("senior");
    expect(levelOf("Sr. Engineer")).toBe("senior");
    expect(levelOf("my first job, junior or intern")).toBe("entry");
    expect(levelOf("junior to senior")).toBeNull();
    expect(levelOf("Solidity")).toBeNull();
    expect(levelOf(null)).toBeNull();
  });
});

describe("fitReasons", () => {
  it("always starts with the role, then the person's words when the title has them", () => {
    expect(fitReasons(pick(), profile({ remoteMode: null }), ctx())).toEqual(["Matches your Engineer role.", "Remote."]);
    expect(fitReasons(pick(), profile(), ctx({ words: "solidity" }))[0])
      .toBe('Matches your Engineer role, and the title has your words "solidity".');
  });

  it("a job matched by the person's own-words role (users.role_text) says that phrase, not a role or its score", () => {
    const tok = pick({ job: job({ title: "Tokenomics Designer", roles: ["designer"] }), role: "designer", keyword: "tokenomics designer" });
    const r = fitReasons(tok, profile(), ctx({ words: "tokenomics design", scores: { designer: 80 } }));
    expect(r[0]).toBe('Matches "tokenomics designer" from your own words.');
    expect(r.join(" ")).not.toMatch(/Designer role|score is/);
    expect(r).toContain("Remote, as you asked.");
  });

  it("salary only when it meets the person's minimum, with both amounts", () => {
    const paid = job({ salary: { min: 120_000, max: 150_000, currency: "USD", period: "year" } });
    const r = fitReasons(pick({ job: paid, meetsSalary: true }), profile({ salaryMin: 100_000, salaryCurrency: "USD" }), ctx());
    expect(r).toContain("Pays $120k to $150k, meets your $100k minimum.");
    const low = fitReasons(pick({ job: paid, meetsSalary: false }), profile({ salaryMin: 200_000, salaryCurrency: "USD" }), ctx());
    expect(low.join(" ")).not.toMatch(/Pays|minimum/);
    // Мінімум у євро: сума людини своєю валютою.
    const eur = fitReasons(pick({ job: paid, meetsSalary: true }), profile({ salaryMin: 90_000, salaryCurrency: "EUR" }), ctx());
    expect(eur).toContain("Pays $120k to $150k, meets your €90k minimum.");
  });

  it("level only when the person named it and the title says the same", () => {
    expect(fitReasons(pick(), profile(), ctx({ words: "senior solidity" }))).toContain("A senior role, the level you asked for.");
    expect(fitReasons(pick({ job: job({ title: "Junior Solidity Engineer" }) }), profile(), ctx({ words: "junior" })))
      .toContain("An entry-level role, the level you asked for.");
    expect(fitReasons(pick(), profile(), ctx({ words: "junior" })).join(" ")).not.toContain("level");
  });

  it("place: the person's city, or remote as asked", () => {
    const lisbon = pick({ job: job({ location: "Lisbon", remote: false }), place: "city" });
    expect(fitReasons(lisbon, profile({ remoteMode: "city", city: "Lisbon, Portugal" }), ctx())).toContain("In Lisbon, where you want to work.");
    expect(fitReasons(pick(), profile({ remoteMode: "remote,city", city: "Lisbon" }), ctx())).toContain("Remote, as you asked.");
  });

  it("the score only when it is there and high enough", () => {
    expect(fitReasons(pick(), profile({ remoteMode: null }), ctx({ scores: { engineer: 72.4 } })))
      .toContain("Your Engineer score is 72, from your public work.");
    expect(fitReasons(pick(), profile(), ctx({ scores: { engineer: 31 } })).join(" ")).not.toContain("score");
    expect(fitReasons(pick(), profile(), ctx({ scores: { trader: 90 } })).join(" ")).not.toContain("score");
    expect(fitReasons(pick(), profile(), ctx({ scores: { engineer: null } })).join(" ")).not.toContain("score");
  });

  it("never more than three, in order of weight, and never an em dash", () => {
    const paid = job({ title: "Senior Solidity Engineer \u2014 DeFi", salary: { min: 150_000, max: null, currency: "USD", period: "year" } });
    const r = fitReasons(pick({ job: paid, meetsSalary: true }), profile({ salaryMin: 120_000, salaryCurrency: "USD" }),
      ctx({ words: "senior solidity defi", scores: { engineer: 88 } }));
    expect(r).toHaveLength(MAX_REASONS);
    expect(r).toEqual([
      'Matches your Engineer role, and the title has your words "solidity" and "defi".',
      "Pays from $150k, meets your $120k minimum.",
      "A senior role, the level you asked for.",
    ]);
    expect(fitLine(pick({ job: paid, meetsSalary: true }), profile(), ctx())).not.toMatch(/[\u2014\u2013]/);
  });

  it("an older job still says it is open and when it was posted, after the reasons", () => {
    const now = new Date("2026-09-14T10:00:00Z");
    const old = job({ postedAt: now.getTime() - 43 * 86_400_000 });
    expect(fitNote(pick({ job: old }), now)).toBe("Still open, posted 6 weeks ago.");
    expect(fitLine(pick({ job: old }), profile(), ctx(), now)).toBe("Matches your Engineer role. Remote, as you asked. Still open, posted 6 weeks ago.");
    // Свіжа: без примітки.
    const fresh = job({ postedAt: now.getTime() - 3 * 86_400_000 });
    expect(fitNote(pick({ job: fresh }), now)).toBeNull();
    expect(fitLine(pick({ job: fresh }), profile(), ctx(), now)).toBe("Matches your Engineer role. Remote, as you asked.");
  });
});
