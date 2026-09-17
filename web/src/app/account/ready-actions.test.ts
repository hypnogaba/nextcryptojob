import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth/session";
import { exec, harness, resetHarness, rows } from "@/test/harness";
import { CARD_WAIT_MS } from "@/lib/score/result";
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

  it("issues the first card for the main role (first chosen, item 7) once the job is done", async () => {
    await finished(); // roles: ["bd","marketing_content"], bd chosen first
    job("done");
    score("bd", 44);
    score("marketing_content", 61); // higher score, but not the main role
    const res = await checkScoreReadyAction();
    expect(res.ready).toBe(true);
    expect(res).toMatchObject({ ready: true, path: expect.stringMatching(/^\/c\//) });
    expect(rows("SELECT role, display_name FROM cards")).toEqual([{ role: "bd", display_name: "@ada" }]);
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

  // 17.09, власник: «картка сама не створилась». Джерела людина додає по одному вже після
  // анкети, тож sourcesChanged лишається true, а правило 60 секунд відкидає нове завдання:
  // крок черги назавжди «enqueue». Стара умова («лише коли done») не видавала картку ніколи.
  it("issues the card from the score it already has when sources changed after the last job", async () => {
    await finished();
    job("done", 10);
    score("bd", 52);
    exec("INSERT INTO audit_log (actor, action) VALUES ('u', 'sources.change')");

    // Перші секунди чекаємо свіжий бал: картка варта того, щоб стати з новим числом.
    await expect(checkScoreReadyAction(0)).resolves.toEqual({ ready: false });
    // Але не безкінечно: далі картка виходить з того балу, що вже є.
    const res = await checkScoreReadyAction(CARD_WAIT_MS + 1);
    expect(res).toMatchObject({ ready: true });
    expect(rows("SELECT role FROM cards")).toEqual([{ role: "bd" }]);
  });

  it("puts a fresh job in the queue itself when sources changed", async () => {
    await finished();
    job("done", 120);
    score("bd", 52);
    exec("INSERT INTO audit_log (actor, action) VALUES ('u', 'sources.change')");
    await checkScoreReadyAction(0);
    expect(rows("SELECT COUNT(*) AS n FROM score_jobs WHERE status = 'queued'")).toEqual([{ n: 1 }]);
  });

  it("waits for the engine while a job runs, but not longer than the wait", async () => {
    await finished();
    job("running", 5);
    score("bd", 52);
    await expect(checkScoreReadyAction(0)).resolves.toEqual({ ready: false });
    // Рушій може й зависнути (sweepStuck бере його за 10 хвилин). Людина не мусить сидіти без
    // картки весь цей час: після CARD_WAIT_MS виходить картка з наявного балу.
    await expect(checkScoreReadyAction(CARD_WAIT_MS + 1)).resolves.toMatchObject({ ready: true });
  });

  it("is not ready when nothing scored yet", async () => {
    await finished();
    job("done");
    await expect(checkScoreReadyAction()).resolves.toEqual({ ready: false });
  });
});
