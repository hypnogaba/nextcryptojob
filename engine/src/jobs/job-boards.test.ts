// Реєстр дошок екосистем і фондів (db/jobs/seed/boards.json) і парсер сторінки дошки проти знятих
// сторінок (fixtures: jobs.solana.com 14.09.2026, jobs.hashed.com 14.09.2026, обрізані до потрібного).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FakeJobsDb } from "../testing/jobs-fake.js";
import { type BoardRegistry, boardProblems, boardsSql, getroBoards, loadBoardRegistry, type SeedJobBoard } from "./job-boards.js";
import { parseBoardPage } from "./sources/getro.js";
import { JobsStore } from "./store.js";

const fixture = (name: string): string => readFileSync(new URL(`./sources/fixtures/${name}`, import.meta.url), "utf8");
const reg = loadBoardRegistry();
const bySlug = new Map(reg.boards.map((b) => [b.slug, b]));

const board = (over: Partial<SeedJobBoard>): SeedJobBoard => ({
  slug: "x", label: "X", kind: "fund", url: "https://jobs.x.vc/jobs", platform: "getro", platform_id: "1", companies: null,
  decision: "discover", crypto_scope: "all", reason: "test", checked_at: "2026-09-14", ...over,
});

describe("реєстр дошок (boards.json)", () => {
  it("проходить перевірку форми; дошки власника на місці з номером колекції зі сторінки", () => {
    expect(boardProblems(reg)).toEqual([]);
    expect(bySlug.get("solana")).toMatchObject({ platform: "getro", platform_id: "858", decision: "discover", url: "https://jobs.solana.com/jobs" });
    expect(bySlug.get("cyber-fund")).toMatchObject({ platform: "getro", platform_id: "9035", decision: "discover", url: "https://talent.cyber.fund/companies" });
  });

  it("Consider ніколи не читаємо: лише skip або manual (портфель з публічної сторінки фонду)", () => {
    const consider = reg.boards.filter((b) => b.platform === "consider");
    expect(consider.length).toBeGreaterThan(0);
    for (const b of consider) expect(["skip", "manual"]).toContain(b.decision);
  });

  it("кожна дошка з переліку задачі є в реєстрі з рішенням і причиною", () => {
    const required = ["solana", "cyber-fund", "ethereum", "arbitrum", "optimism", "base", "polygon", "avalanche", "sui", "aptos", "near",
      "cosmos", "ton", "starknet", "zksync", "celestia", "monad", "berachain", "injective", "sei", "polkadot", "filecoin", "protocol-labs",
      "chainlink", "hedera", "algorand", "tezos", "stellar", "cardano", "a16z-crypto", "paradigm", "multicoin", "pantera", "polychain",
      "dragonfly", "electric-capital", "coinbase-ventures", "hashed", "framework", "variant", "1kx", "placeholder", "castle-island",
      "galaxy-ventures", "jump-crypto", "delphi", "hack-vc", "mechanism", "spartan", "animoca", "yzi-labs", "robot-ventures", "lemniscap",
      "blockchain-capital", "blockchain-association", "portal-ventures", "alliance", "outlier-ventures", "bitkraft", "dwf", "fenbushi",
      "iosg", "hashkey", "okx-ventures", "kraken-ventures"];
    expect(required.filter((s) => !bySlug.has(s))).toEqual([]);
    for (const b of reg.boards) expect(b.reason.length).toBeGreaterThan(10);
  });

  it("розвідка бере лише Getro з рішенням discover, з хостом дошки для «лише на Getro»", () => {
    const g = getroBoards(reg);
    expect(g.every((b) => Number.isInteger(b.collectionId) && b.collectionId > 0)).toBe(true);
    expect(g.map((b) => b.slug)).toContain("solana");
    expect(g.find((b) => b.slug === "solana")).toMatchObject({ collectionId: 858, host: "jobs.solana.com", cryptoScope: "all" });
    expect(g.map((b) => b.slug)).not.toContain("paradigm");
  });

  it("перевірка ловить помилки: Consider на розвідці, Getro без номера, повтор колекції, не https", () => {
    const bad: BoardRegistry = { version: 1, source: "t", boards: [
      board({ slug: "a", platform: "consider", platform_id: null }),
      board({ slug: "b", platform_id: null }),
      board({ slug: "c", platform_id: "7" }), board({ slug: "d", platform_id: "7" }),
      board({ slug: "e", url: "http://jobs.e.vc", decision: "skip", platform: "none", platform_id: null }),
    ] };
    const p = boardProblems(bad).join(" | ");
    expect(p).toMatch(/boards\.a: розвідка вміє лише Getro/);
    expect(p).toMatch(/boards\.a: Consider не читаємо/);
    expect(p).toMatch(/boards\.b: Getro без номера/);
    expect(p).toMatch(/boards\.d: колекція 7 уже є/);
    expect(p).toMatch(/boards\.e: адреса не https/);
  });

  it("SQL лягає в схему (0003) і store читає з бази лише дошки на розвідку", async () => {
    const db = new FakeJobsDb();
    for (const sql of boardsSql(reg)) db.sqlite.exec(sql);
    // Повторне накочування нічого не міняє (ON CONFLICT DO NOTHING).
    for (const sql of boardsSql(reg)) db.sqlite.exec(sql);
    expect(db.get<{ n: number }>("SELECT COUNT(*) AS n FROM job_boards")?.n).toBe(reg.boards.length);
    const fromDb = await new JobsStore(db, true).loadGetroBoards();
    expect(fromDb).toEqual([...getroBoards(reg)].sort((a, b) => a.slug.localeCompare(b.slug)));
    db.close();
  });
});

describe("сторінка дошки: платформа за самою сторінкою", () => {
  it("Getro: номер колекції з __NEXT_DATA__ (jobs.solana.com)", () => {
    expect(parseBoardPage(fixture("getro-board-solana.html"))).toEqual({
      platform: "getro", getro: { id: 858, name: "Solana Network Opportunities", kind: "ecosystem", host: "jobs.solana.com" } });
  });

  it("Consider за своїми адресами (jobs.hashed.com); решта unknown", () => {
    expect(parseBoardPage(fixture("consider-board-hashed.html"))).toEqual({ platform: "consider", getro: null });
    expect(parseBoardPage("<html><body><a href='https://jobs.ashbyhq.com/acme'>Jobs</a></body></html>")).toEqual({ platform: "unknown", getro: null });
    expect(parseBoardPage('<script id="__NEXT_DATA__" type="application/json">{broken</script>')).toEqual({ platform: "unknown", getro: null });
  });
});
