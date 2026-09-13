import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runAction } from "@/lib/crm/actions";
import { webhookSecret, verifySignature } from "@/lib/crm/webhooks";
import { all, crmDb, publishFormula } from "@/test/crm-fixtures";
import { addCandidate, addTestCompany, ask, BOT_TOKEN, stubNetwork, type Network } from "@/test/intro-fixtures";
import type { TestDb } from "@/test/sqlite-d1";
import { CRONS, runCron, SCHEDULE, type CronEnv, type CronJob } from "./index";

/**
 * Планувальник: рядки cron збігаються з wrangler.jsonc, кожен тригер має задачі,
 * збій однієї задачі не зупиняє інших, а 5-хвилинний запуск прострочує
 * знайомство і того ж запуску доставляє його вебхук intro.expired.
 */

const KEY = "test-webhook-signing-key-0123456789abcdef";
let db: TestDb;
let net: Network;

beforeEach(() => {
  db = crmDb();
  publishFormula(db.raw);
  net = stubNetwork();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("schedule", () => {
  it("the cron strings are exactly the triggers in wrangler.jsonc, and each one has jobs", () => {
    const config = readFileSync(new URL("../../../wrangler.jsonc", import.meta.url), "utf8");
    const crons = JSON.parse(`[${/"crons":\s*\[([^\]]*)\]/.exec(config)?.[1] ?? ""}]`) as string[];
    expect(crons.sort()).toEqual(Object.values(CRONS).sort());
    for (const cron of crons) expect(SCHEDULE[cron]?.length).toBeGreaterThan(0);
    expect(config).toMatch(/"main":\s*"worker\.ts"/);
  });
});

describe("runCron", () => {
  const env = () => ({ DB: db.d1 }) as CronEnv;

  it("runs every job of the trigger even when one fails, and reports counts", async () => {
    const ran: string[] = [];
    const jobs: CronJob[] = [
      { name: "first", run: async () => (ran.push("first"), { done: 1 }) },
      { name: "broken", run: async () => { throw new Error("D1_ERROR: boom"); } },
      { name: "last", run: async () => (ran.push("last"), { done: 2 }) },
    ];
    const report = await runCron("*/5 * * * *", env(), { schedule: { "*/5 * * * *": jobs } });
    expect(ran).toEqual(["first", "last"]);
    expect(report.jobs.map((j) => [j.job, j.ok])).toEqual([
      ["first", true],
      ["broken", false],
      ["last", true],
    ]);
    expect(report.jobs[1].error).toBe("D1_ERROR: boom");
    expect(report.jobs[2].counts).toEqual({ done: 2 });
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"job":"broken"'));
  });

  it("an unknown trigger does nothing", async () => {
    expect(await runCron("7 7 * * *", env())).toEqual({ cron: "7 7 * * *", jobs: [] });
  });

  it("hands the scheduled time to saved-search alerts and the real time to the rest", async () => {
    const seen: Record<string, string> = {};
    const probe = (name: string, pick: "now" | "scheduled"): CronJob => ({
      name,
      run: async (_env, t) => {
        seen[name] = t[pick].toISOString();
        return {};
      },
    });
    await runCron("0 * * * *", env(), {
      scheduledTime: Date.parse("2026-09-12T13:00:00Z"),
      now: () => new Date("2026-09-12T13:00:04Z"),
      schedule: { "0 * * * *": [probe("alerts", "scheduled"), probe("other", "now")] },
    });
    expect(seen).toEqual({ alerts: "2026-09-12T13:00:00.000Z", other: "2026-09-12T13:00:04.000Z" });
  });

  it("every 5 minutes: expires a due intro and delivers its intro.expired webhook in the same run; a second run does nothing", async () => {
    const hits: { headers: Headers; body: string }[] = [];
    const base = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://hooks.acme.io/")) {
        hits.push({ headers: new Headers(init?.headers), body: String(init?.body) });
        return new Response("ok");
      }
      return base(input, init);
    });
    const c = await addTestCompany(db, net, { env: { WEBHOOK_SIGNING_KEY: KEY } });
    await runAction("set_webhook", { url: "https://hooks.acme.io/ncj" }, c.agent);
    const alice = addCandidate(db);
    const introId = (await ask(c.agent, alice.id)).output.intro_id;

    const after14Days = new Date("2026-09-26T12:02:00Z");
    const cronEnv = { DB: db.d1, WEBHOOK_SIGNING_KEY: KEY, TELEGRAM_BOT_TOKEN: BOT_TOKEN, SITE_URL: "https://nextcryptojob.xyz" } as CronEnv;
    const report = await runCron(CRONS.every5Minutes, cronEnv, { now: () => after14Days });
    expect(report.jobs).toMatchObject([
      { job: "intros.expire", ok: true, counts: { expired: 1 } },
      { job: "webhooks.deliver", ok: true, counts: { delivered: 1 } },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].headers.get("NCJ-Event-Type")).toBe("intro.expired");
    expect(JSON.parse(hits[0].body).data.intro).toMatchObject({ intro_id: introId, status: "expired", contact: null });
    expect(await verifySignature(hits[0].headers.get("NCJ-Signature")!, hits[0].body, await webhookSecret(KEY, c.co, 1), after14Days)).toBe(true);
    expect(all(db.raw, "SELECT status, webhook_state FROM intros WHERE id = ?", introId)).toEqual([{ status: "expired", webhook_state: "delivered" }]);

    const again = await runCron(CRONS.every5Minutes, cronEnv, { now: () => new Date(after14Days.getTime() + 5 * 60_000) });
    expect(again.jobs.map((j) => j.counts)).toMatchObject([{ expired: 0 }, { attempted: 0 }]);
    expect(hits).toHaveLength(1);
  });
});
