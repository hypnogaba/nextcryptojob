import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { crmDb } from "@/test/crm-fixtures";
import { harness, resetHarness, rows } from "@/test/harness";
import { GET } from "./route";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);

/** /go/share-x: рахує funnel_days ('share_click') і веде на x.com, хост завжди фіксований. */

beforeEach(() => {
  resetHarness();
  const { raw, d1 } = crmDb();
  harness.raw = raw;
  harness.env.DB = d1;
});

describe("GET /go/share-x", () => {
  it("counts a share_click event and redirects to x.com/intent/post with the same params", async () => {
    const req = new NextRequest("https://nextcryptojob.xyz/go/share-x?text=I%20scored%2072&url=https%3A%2F%2Fnextcryptojob.xyz%2Fc%2Fabc");
    const res = await GET(req);
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin).toBe("https://x.com");
    expect(location.pathname).toBe("/intent/post");
    expect(location.searchParams.get("text")).toBe("I scored 72");
    expect(location.searchParams.get("url")).toBe("https://nextcryptojob.xyz/c/abc");
    expect(rows("SELECT step, count FROM funnel_days")).toEqual([{ step: "share_click", count: 1 }]);
  });

  it("never redirects anywhere except x.com, whatever the query says", async () => {
    const req = new NextRequest("https://nextcryptojob.xyz/go/share-x?url=https://evil.example&text=hi");
    const res = await GET(req);
    expect(new URL(res.headers.get("location")!).origin).toBe("https://x.com");
  });
});
