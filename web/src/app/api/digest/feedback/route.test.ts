import { beforeEach, describe, expect, it, vi } from "vitest";
import { feedbackUrl } from "@/lib/digest/feedback";
import { exec, resetHarness, rows, TEST_SECRET } from "@/test/harness";
import { GET, POST } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);

const SITE = "https://nextcryptojob.xyz";

beforeEach(() => {
  resetHarness();
  exec("INSERT INTO users (id, email, channel) VALUES ('ada', 'ada@example.com', 'email'), ('bob', 'bob@example.com', 'email')");
  exec("INSERT INTO digest_runs (id, user_id, local_date, status, jobs, channel) VALUES ('dg_1', 'ada', '2026-09-12', 'sent', 1, 'email')");
  exec("INSERT INTO sent (user_id, job_ref, source, digest_id, position, status, channel, why) VALUES ('ada', 'nr:jabc', 'nextrole', 'dg_1', 1, 'sent', 'email', 'x')");
});

const votes = () => rows("SELECT user_id, job_ref, vote, reason FROM job_feedback");

describe("/api/digest/feedback (Not for me in the email)", () => {
  it("GET shows the reasons and a button, and stores nothing (mail scanners open links)", async () => {
    const res = await GET(new Request(await feedbackUrl(SITE, TEST_SECRET, "ada", "nr:jabc")));
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<form method="post"');
    expect(html).toContain("Wrong level");
    expect(votes()).toEqual([]);
  });

  it("POST stores a thumbs down with the reason and says the company is hidden for 30 days", async () => {
    const url = await feedbackUrl(SITE, TEST_SECRET, "ada", "nr:jabc");
    const res = await POST(new Request(url, { method: "POST", body: new URLSearchParams({ reason: "wrong_level" }) }));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("30 days");
    expect(votes()).toEqual([{ user_id: "ada", job_ref: "nr:jabc", vote: "down", reason: "wrong_level" }]);
  });

  it("an unknown reason is ignored, the vote is still stored", async () => {
    const url = await feedbackUrl(SITE, TEST_SECRET, "ada", "nr:jabc");
    await POST(new Request(url, { method: "POST", body: new URLSearchParams({ reason: "<script>" }) }));
    expect(votes()).toEqual([{ user_id: "ada", job_ref: "nr:jabc", vote: "down", reason: null }]);
  });

  it("refuses a forged or changed link and stores nothing", async () => {
    const good = new URL(await feedbackUrl(SITE, TEST_SECRET, "ada", "nr:jabc"));
    const other = new URL(good);
    other.searchParams.set("u", "bob");
    const swapped = new URL(good);
    swapped.searchParams.set("j", "nr:other");
    const noSig = new URL(good);
    noSig.searchParams.delete("t");
    for (const u of [other, swapped, noSig]) {
      expect((await POST(new Request(u, { method: "POST" }))).status).toBe(403);
      expect((await GET(new Request(u))).status).toBe(403);
    }
    expect(votes()).toEqual([]);
  });

  it("a job that was never sent to this person is not found, even with a valid signature", async () => {
    const url = await feedbackUrl(SITE, TEST_SECRET, "bob", "nr:jabc");
    expect((await POST(new Request(url, { method: "POST" }))).status).toBe(404);
    expect(votes()).toEqual([]);
  });
});
