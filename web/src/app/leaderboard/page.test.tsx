import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createCard } from "@/lib/card/store";
import { exec, harness, resetHarness } from "@/test/harness";
import LeaderboardPage from "./page";

vi.mock("@opennextjs/cloudflare", async () => (await import("@/test/harness")).cloudflareModule);
vi.mock("next/headers", async () => (await import("@/test/harness")).headersModule);

const render = async (page?: number) =>
  renderToStaticMarkup(await LeaderboardPage({ searchParams: Promise.resolve(page ? { page: String(page) } : {}) }));

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

  it("each row opens that card, where the score breakdown is public", async () => {
    user("a");
    const slug = await card("a", "engineer", 90, "@high");
    const html = await render();
    expect(html).toContain(`href="/c/${slug}"`);
    expect(html).toContain("See how this score was built");
  });

  it("says so when no one has a public card yet", async () => {
    const html = await render();
    expect(html).toContain("No public cards yet.");
  });
});

/**
 * Власник 16.09, п.2 («якщо в нас буде 100 людей»): 25 рядків на сторінку, `?page=` у запиті,
 * без стану на клієнті. Ці тести не залежать від точних значень CSS (padding, розмір шрифту) -
 * лише від поведінки: скільки рядків на сторінці й куди ведуть Next/Previous.
 */
describe("/leaderboard paging (item 2)", () => {
  async function fillBoard(count: number) {
    for (let i = 0; i < count; i++) {
      const id = `u${i}`;
      user(id);
      // Бал спадає з індексом, тож порядок передбачуваний: u0 найвищий бал, останній найнижчий.
      await card(id, "bd", 100 - i, `@person${String(i).padStart(3, "0")}`);
    }
  }

  it("shows 25 rows on page 1 and offers Next but not Previous", async () => {
    await fillBoard(30);
    const html = await render();
    // Кожен нік трапляється в HTML кілька разів (aria-label на посиланні, aria-label на картці,
    // видимий текст): дедуплікуємо, порядок вставки зберігається.
    const rows = [...new Set(html.match(/@person\d{3}/g) ?? [])];
    expect(rows).toHaveLength(25);
    expect(rows[0]).toBe("@person000");
    expect(rows[24]).toBe("@person024");
    expect(html).toContain(">Next<");
    expect(html).not.toContain(">Previous<");
  });

  it("shows the remaining rows on page 2, with Previous back to page 1 and no Next", async () => {
    await fillBoard(30);
    const html = await render(2);
    // Кожен нік трапляється в HTML кілька разів (aria-label на посиланні, aria-label на картці,
    // видимий текст): дедуплікуємо, порядок вставки зберігається.
    const rows = [...new Set(html.match(/@person\d{3}/g) ?? [])];
    expect(rows).toHaveLength(5);
    expect(rows[0]).toBe("@person025");
    expect(rows[4]).toBe("@person029");
    expect(html).toContain(">Previous<");
    expect(html).not.toContain(">Next<");
    expect(html).toContain('href="/leaderboard"');
  });

  it("keeps rank numbers continuous across pages, not reset per page", async () => {
    await fillBoard(30);
    const html = await render(2);
    // Місце №26 (перший рядок сторінки 2) має бути видно, а не знову №1.
    expect(html).toMatch(/>26</);
    expect(html).not.toContain(">1<");
  });

  it("does not show paging controls when everything fits on one page", async () => {
    await fillBoard(10);
    const html = await render();
    expect(html).not.toContain(">Next<");
    expect(html).not.toContain(">Previous<");
  });
});
