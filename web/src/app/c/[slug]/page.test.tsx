import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createSession } from "@/lib/auth/session";
import { createCard } from "@/lib/card/store";
import { exec, harness, resetHarness } from "@/test/harness";
import CardPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);
vi.mock("next/navigation", async () => ({
  ...(await import("@/test/harness")).navigationModule,
  notFound: () => {
    throw new Error("notFound");
  },
}));

let slug = "";
const render = async () => renderToStaticMarkup(await CardPage({ params: Promise.resolve({ slug }) }));

beforeEach(async () => {
  resetHarness();
  harness.headers = new Headers({ host: "nextcryptojob.xyz" });
  exec("INSERT INTO users (id, email, roles) VALUES ('u', 'u@example.com', '[\"bd\"]')");
  exec("INSERT INTO identities (user_id, kind, value) VALUES ('u', 'x', 'ada')");
  exec("INSERT INTO scores (user_id, role, score, breakdown_json, formula_version) VALUES ('u', 'bd', 44, '{}', 'v6')");
  slug = await createCard(harness.env.DB, { userId: "u", role: "bd", score: 44, displayName: "@ada", formulaVersion: "v6" });
});

describe("public card page (trust model of 13.09)", () => {
  it("a visitor sees a quiet self-reported line and can report the card; no wallet marker", async () => {
    const html = await render();
    expect(html).toContain("Self-reported: the card owner added their X, GitHub and wallets themselves.");
    expect(html).toContain("Report this card");
    expect(html).not.toContain("Wallets not verified");
    expect(html).not.toContain("Share on X");
  });

  it("the owner sees Share on X and the images, not the report form", async () => {
    await createSession("u", null);
    const html = await render();
    expect(html).toContain("Share on X");
    expect(html).toContain(`/c/${slug}/share/tall`);
    expect(html).not.toContain("Report this card");
  });
});
