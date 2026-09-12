import { afterEach, describe, expect, it, vi } from "vitest";

const crm = vi.hoisted(() => ({
  onVisibilityChanged: vi.fn(async (_userId: string, _visible: boolean) => ({ cards: 0 })),
  candidateErasurePlan: vi.fn(),
  erasureBlockReason: vi.fn(async (_userId: string, _d?: D1Database): Promise<string | null> => null),
}));
vi.mock("@/lib/crm/visibility", () => crm);
vi.mock("@/lib/db", () => ({ db: () => ({}) as D1Database }));

import { notifyCrmErasure, notifyCrmVisibility } from "./hooks";

afterEach(() => vi.restoreAllMocks());

describe("account hooks into the CRM", () => {
  it("a CRM failure after a saved visibility change is logged, not thrown", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    crm.onVisibilityChanged.mockRejectedValueOnce(new Error("D1_ERROR: busy"));
    await expect(notifyCrmVisibility("u1", false)).resolves.toBeUndefined();
    expect(crm.onVisibilityChanged).toHaveBeenCalledWith("u1", false);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("D1_ERROR: busy"));
  });

  it("erasure mail failures after the commit are logged, not thrown; plan errors stop the deletion", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const d = {} as D1Database;
    crm.candidateErasurePlan.mockResolvedValueOnce({
      companies: 1,
      contactShared: 1,
      statements: [],
      notify: async () => {
        throw new Error("mail down");
      },
    });
    const erasure = await notifyCrmErasure("u1", d);
    expect(crm.candidateErasurePlan).toHaveBeenCalledWith("u1", { db: d });
    await expect(erasure.afterCommit()).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining("mail down"));

    crm.candidateErasurePlan.mockRejectedValueOnce(new Error("D1_ERROR: read"));
    await expect(notifyCrmErasure("u1", d)).rejects.toThrow("D1_ERROR: read");
  });
});
