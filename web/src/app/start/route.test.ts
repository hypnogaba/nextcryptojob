import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { crmDb } from "@/test/crm-fixtures";
import { harness, resetHarness, rows } from "@/test/harness";
import { GET } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

/** GET /start: перший крок брифу (D, funnel_days 'brief_started'), для гостя і для входу. */

beforeEach(() => {
  resetHarness();
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
});

describe("GET /start", () => {
  it("counts a brief_started event and sends a visitor to /login", async () => {
    const res = await GET(new NextRequest("https://nextcryptojob.xyz/start"));
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe("https://nextcryptojob.xyz/login");
    expect(rows("SELECT step, count FROM funnel_days")).toEqual([{ step: "brief_started", count: 1 }]);
  });

  it("counts again on a second visit, same day", async () => {
    await GET(new NextRequest("https://nextcryptojob.xyz/start"));
    await GET(new NextRequest("https://nextcryptojob.xyz/start?brief=security%20auditor%20in%20Paris"));
    expect(rows("SELECT count FROM funnel_days WHERE step = 'brief_started'")).toEqual([{ count: 2 }]);
  });
});
