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

describe("proof profile under the card", () => {
  beforeEach(() => {
    exec(
      `INSERT INTO source_facts (user_id, source, facts_json) VALUES ('u', 'x', '{"followers":5000,"own30d":9}')`,
    );
    exec("UPDATE users SET telegram_username = 'ada_tg', role_text = 'BD at secretcorp' WHERE id = 'u'");
  });

  const renderWith = async (k?: string) =>
    renderToStaticMarkup(
      await CardPage({ params: Promise.resolve({ slug }), searchParams: Promise.resolve(k ? { k } : {}) }),
    );

  it("without a key shows facts only", async () => {
    const html = await renderWith();
    expect(html).toContain("5k followers on X");
    expect(html).toContain('data-proof="public"');
    for (const p of ["ada_tg", "secretcorp", "x.com/ada", "u@example.com"]) expect(html).not.toContain(p);
  });

  it("the current owner key opens links, words and contact; an old or wrong key does not", async () => {
    const { ensureKeyVersion, profileKey, resetKey } = await import("@/lib/card/profile-prefs");
    await ensureKeyVersion(harness.env.DB, "u");
    const key1 = await profileKey(harness.env.SESSION_SECRET!, "u", 1);
    const html = await renderWith(key1);
    expect(html).toContain('data-proof="full"');
    expect(html).toContain("https://x.com/ada");
    expect(html).toContain("https://t.me/ada_tg");
    expect(html).toContain("secretcorp");

    await resetKey(harness.env.DB, "u");
    expect(await renderWith(key1)).toContain('data-proof="public"');
    expect(await renderWith("0".repeat(32))).toContain('data-proof="public"');
  });
});
