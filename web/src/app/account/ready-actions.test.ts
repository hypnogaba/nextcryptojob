import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth/session";
import { exec, harness, resetHarness, rows } from "@/test/harness";
import { checkScoreReadyAction } from "./ready-actions";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

async function finished(roles = '["bd","marketing_content"]') {
  exec("INSERT INTO users (id, email, onboarding_step, roles) VALUES ('u', 'ada@example.com', 'done', ?)", roles);
  exec("INSERT INTO consents (user_id, kind, granted, text_version) VALUES ('u', 'scoring', 1, 'v1')");
  exec("INSERT INTO identities (user_id, kind, value) VALUES ('u', 'x', 'ada')");
  await createSession("u", null);
}

function job(status: string, agoSeconds = 30) {
  exec(
    "INSERT INTO score_jobs (user_id, reason, status, queued_at, started_at) VALUES ('u', 'connect', ?, datetime('now', ?), datetime('now', ?))",
    status,
    `-${agoSeconds} seconds`,
    `-${agoSeconds - 1} seconds`,
  );
}

function score(role: string, value: number | null) {
  exec("INSERT INTO scores (user_id, role, score, breakdown_json, formula_version) VALUES ('u', ?, ?, '{}', 'v6')", role, value);
}

beforeEach(() => {
  resetHarness();
  harness.headers = new Headers({ host: "nextcryptojob.xyz", "cf-connecting-ip": "203.0.113.9" });
});

// Раунд 5, п.2 + п.14: людина, хто пішла з /welcome/score до кінця балу («Skip»), бачить картку
// сама на /account, коли рушій закінчить: checkScoreReadyAction опитує це саме, без повернення туди.
describe("checkScoreReadyAction", () => {
  it("is not ready while the job still waits", async () => {
    await finished();
    job("queued", 3);
    await expect(checkScoreReadyAction()).resolves.toEqual({ ready: false });
  });

  it("issues the first card for the best-scoring role once the job is done, like issueFirstCardAction", async () => {
    await finished();
    job("done");
    score("bd", 44);
    score("marketing_content", 61);
    const res = await checkScoreReadyAction();
    expect(res.ready).toBe(true);
    expect(res).toMatchObject({ ready: true, path: expect.stringMatching(/^\/c\//) });
    expect(rows("SELECT role, display_name FROM cards")).toEqual([{ role: "marketing_content", display_name: "@ada" }]);
  });

  it("reuses the existing card for the best role instead of making a second one", async () => {
    await finished();
    job("done");
    score("marketing_content", 61);
    const first = await checkScoreReadyAction();
    const second = await checkScoreReadyAction();
    expect(second).toEqual(first);
    expect(rows("SELECT COUNT(*) AS n FROM cards")).toEqual([{ n: 1 }]);
  });

  it("is not ready when nothing scored yet", async () => {
    await finished();
    job("done");
    await expect(checkScoreReadyAction()).resolves.toEqual({ ready: false });
  });
});
