import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCard } from "@/lib/card/store";
import { exec, harness, resetHarness } from "@/test/harness";
import LeaderboardPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

const render = async () => renderToStaticMarkup(await LeaderboardPage());

function user(id: string, cardPublic: 0 | 1 = 1) {
  exec("INSERT INTO users (id, email, roles, card_public) VALUES (?, ?, '[\"bd\"]', ?)", id, `${id}@example.com`, cardPublic);
}

async function card(userId: string, role: string, score: number, displayName: string): Promise<string> {
  return createCard(harness.env.DB, { userId, role, score, displayName, formulaVersion: "v6" });
}

beforeEach(() => {
  resetHarness();
});

describe("/leaderboard (item 7)", () => {
  it("lists public cards, highest score first", async () => {
    user("a");
    user("b");
    await card("a", "bd", 40, "@low");
    await card("b", "engineer", 90, "@high");
    const html = await render();
    expect(html.indexOf("@high")).toBeLessThan(html.indexOf("@low"));
    expect(html).toContain('href="/c/');
  });

  it("excludes people who turned off the leaderboard in Privacy", async () => {
    user("a", 1);
    user("b", 0);
    await card("a", "bd", 40, "@shown");
    await card("b", "engineer", 90, "@hidden");
    const html = await render();
    expect(html).toContain("@shown");
    expect(html).not.toContain("@hidden");
  });

  it("excludes a revoked card (superseded by a newer one)", async () => {
    user("a");
    const first = await card("a", "bd", 40, "@old-name");
    await card("a", "engineer", 90, "@new-name");
    const html = await render();
    expect(html).not.toContain("@old-name");
    expect(html).toContain("@new-name");
    expect(html).not.toContain(`href="/c/${first}"`);
  });

  it("says so when no one has a public card yet", async () => {
    const html = await render();
    expect(html).toContain("No public cards yet.");
  });
});
