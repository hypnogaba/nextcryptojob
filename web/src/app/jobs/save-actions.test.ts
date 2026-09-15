import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth/session";
import { exec, harness, resetHarness, rows } from "@/test/harness";
import { toggleSaveJobAction } from "./save-actions";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

beforeEach(async () => {
  resetHarness();
  exec("INSERT INTO users (id, email) VALUES ('u', 'u@example.com')");
  await createSession("u", null);
});

describe("toggleSaveJobAction (item 16)", () => {
  it("saves a job, then unsaves it", async () => {
    await expect(toggleSaveJobAction("nr:abc", true)).resolves.toEqual({ ok: true });
    expect(rows("SELECT job_ref FROM saved_jobs WHERE user_id = 'u'")).toEqual([{ job_ref: "nr:abc" }]);

    await expect(toggleSaveJobAction("nr:abc", false)).resolves.toEqual({ ok: true });
    expect(rows("SELECT job_ref FROM saved_jobs WHERE user_id = 'u'")).toEqual([]);
  });

  it("refuses a malformed ref instead of writing garbage", async () => {
    await expect(toggleSaveJobAction("'; DROP TABLE saved_jobs; --", true)).resolves.toEqual({ ok: false });
    expect(rows("SELECT COUNT(*) AS n FROM saved_jobs")).toEqual([{ n: 0 }]);
  });
});
