import { describe, expect, it } from "vitest";
import { assertCan, can, type ActorRole } from "./permissions";
import { ActionError } from "./types";

function denial(role: ActorRole, permission: Parameters<typeof assertCan>[1]): ActionError | null {
  try {
    assertCan(role, permission);
    return null;
  } catch (e) {
    if (e instanceof ActionError) return e;
    throw e;
  }
}

describe("permission matrix (spec 2.2)", () => {
  it("everyone with a company identity can search, view and work the pipeline; a paying guest can only search", () => {
    for (const role of ["owner", "member", "agent"] as const) {
      expect(can(role, "candidates.search")).toBe(true);
      expect(can(role, "candidates.view")).toBe(true);
      expect(can(role, "pipeline.write")).toBe(true);
      expect(can(role, "intros.write")).toBe(true);
    }
    expect(can("x402_guest", "candidates.search")).toBe(true);
    expect(can("x402_guest", "candidates.view")).toBe(false);
    expect(can("x402_guest", "intros.write")).toBe(false);
  });

  it("only the owner creates API keys and manages the team", () => {
    expect(can("owner", "api_keys.create")).toBe(true);
    for (const role of ["member", "agent", "x402_guest", "admin"] as const) expect(can(role, "api_keys.create")).toBe(false);
    for (const role of ["member", "agent", "x402_guest", "admin"] as const) expect(can(role, "team.manage")).toBe(false);
    // Адмін відкликає ключі, але не створює.
    expect(can("admin", "api_keys.revoke")).toBe(true);
  });

  it("a member reads the webhook and settings but cannot change them; the agent can set the webhook", () => {
    expect(can("member", "webhook.read")).toBe(true);
    expect(can("member", "webhook.write")).toBe(false);
    expect(can("agent", "webhook.write")).toBe(true);
    expect(can("member", "settings.read")).toBe(true);
    expect(can("member", "settings.write")).toBe(false);
    expect(can("agent", "settings.read")).toBe(false);
  });

  it("USDC month: owner and agent; card billing: owner only", () => {
    expect(can("agent", "billing.usdc")).toBe(true);
    expect(can("member", "billing.usdc")).toBe(false);
    expect(can("agent", "billing.stripe")).toBe(false);
    expect(can("owner", "billing.stripe")).toBe(true);
  });

  it("the admin does not search candidates or see profiles through the CRM", () => {
    expect(can("admin", "candidates.search")).toBe(false);
    expect(can("admin", "candidates.view")).toBe(false);
    expect(can("admin", "access.grant")).toBe(true);
    expect(can("owner", "access.grant")).toBe(false);
  });
});

describe("assertCan", () => {
  it("a guest without a key gets 401 key_required, a company role gets 403 forbidden", () => {
    expect(denial("x402_guest", "pipeline.write")).toMatchObject({ code: "key_required", status: 401 });
    expect(denial("member", "api_keys.create")).toMatchObject({
      code: "forbidden",
      status: 403,
      message: "Only the company owner can create API keys.",
    });
    expect(denial("owner", "api_keys.create")).toBeNull();
  });
});
