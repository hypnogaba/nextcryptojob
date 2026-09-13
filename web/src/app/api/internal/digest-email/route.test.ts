import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppEnv } from "@/lib/db";
import { crmDb } from "@/test/crm-fixtures";
import { exec, harness, resetHarness } from "@/test/harness";
import { POST } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);

const SECRET = "internal-secret-0123456789abcdef";

function signedRequest(): Request {
  const body = JSON.stringify({
    version: 1,
    digest_id: "dg_1",
    user_id: "ada",
    local_date: "2026-09-12",
    ts: Math.floor(Date.now() / 1000),
    jobs: [
      {
        position: 1, title: "Protocol Engineer", company: "Paying Labs", location: "Remote", salary: null,
        why: "Matches your Engineer role. Remote.", url: "https://jobs.example.com/1", posted_by: null, source: "nextrole",
      },
    ],
  });
  const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
  return new Request("https://nextcryptojob.xyz/api/internal/digest-email", {
    method: "POST",
    headers: { "Content-Type": "application/json", "NCJ-Internal-Signature": signature },
    body,
  });
}

function setup(env: Partial<AppEnv>) {
  resetHarness(env);
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
  exec("INSERT INTO users (id, email) VALUES ('ada', 'ada@example.com')");
  exec("INSERT INTO digest_runs (id, user_id, local_date, jobs, channel) VALUES ('dg_1', 'ada', '2026-09-12', 1, 'email')");
}

describe("POST /api/internal/digest-email", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("answers 503 while the Worker has no INTERNAL_API_SECRET", async () => {
    setup({});
    expect((await POST(signedRequest())).status).toBe(503);
  });

  it("sends through the EMAIL binding of the Worker", async () => {
    const send = vi.fn(async () => ({ messageId: "m1" }));
    setup({ INTERNAL_API_SECRET: SECRET, EMAIL: { send } as unknown as SendEmail });
    const res = await POST(signedRequest());
    expect(res.status).toBe(200);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "ada@example.com", subject: "Your 1 crypto job for Sep 12" }));
  });
});
