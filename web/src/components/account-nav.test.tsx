import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountShell } from "./account-nav";

/**
 * Власник 16.09, п.1: кабінет кандидата не пропонує створити компанію (кнопка живе на /company).
 * Власник 16.09, п.6: одна вкладка меню на вакансії, без окремого пункту для збережених.
 */
describe("account cabinet side menu", () => {
  it("has no 'create a company' entry and exactly one jobs entry", () => {
    const html = renderToStaticMarkup(
      <AccountShell active="overview" title="Account">
        <p>content</p>
      </AccountShell>,
    );
    expect(html).not.toMatch(/Company account/i);
    expect(html).not.toContain('href="/company/start"');
    expect(html).not.toMatch(/Saved jobs/i);

    const jobsLinks = html.match(/href="\/jobs"/g) ?? [];
    expect(jobsLinks).toHaveLength(1);
  });

  it("uses the same container width on every cabinet page (no horizontal jump)", () => {
    const overview = renderToStaticMarkup(
      <AccountShell active="overview" title="Account">
        <p>content</p>
      </AccountShell>,
    );
    const jobs = renderToStaticMarkup(
      <AccountShell active="jobs" title="Your jobs">
        <p>content</p>
      </AccountShell>,
    );
    const width = (html: string) => html.match(/max-w-\[[^\]]+\]/)?.[0] ?? html.match(/max-w-\S+/)?.[0];
    expect(width(overview)).toBe(width(jobs));
  });

  it("gives every acct-item the same height and width classes, whichever page is active", () => {
    const html = renderToStaticMarkup(
      <AccountShell active="jobs" title="Your jobs" sub="Matches and picks, updated as your brief changes.">
        <p>content</p>
      </AccountShell>,
    );
    const items = [...html.matchAll(/<a[^>]*class="([^"]*acct-item[^"]*)"/g)].map((m) => m[1]);
    expect(items.length).toBeGreaterThan(1);
    expect(new Set(items).size).toBe(1);
  });

  /**
   * Власник 16.09, п.1: бічне меню «стрибає вверх вниз» між сторінками кабінету, коли на одній є
   * підзаголовок (`sub`) під h1, а на іншій нема, тож висота шапки різна і меню починається на
   * різній висоті. Кожен пункт меню й так має однакову висоту (.acct-item); тепер кожна сторінка
   * кабінету передає `sub`, тож і висота шапки над меню однакова всюди.
   */
  it("every real cabinet page passes both title and sub to AccountShell", () => {
    const pages = [
      "src/app/account/page.tsx",
      "src/app/profile/page.tsx",
      "src/app/jobs/page.tsx",
      "src/app/settings/page.tsx",
    ];
    for (const rel of pages) {
      const src = readFileSync(join(process.cwd(), rel), "utf8");
      const calls = [...src.matchAll(/<AccountShell\s[^>]*>/g)].map((m) => m[0]);
      expect(calls.length, `${rel}: no AccountShell call found`).toBeGreaterThan(0);
      for (const call of calls) {
        expect(call, `${rel}: ${call}`).toMatch(/\btitle=/);
        expect(call, `${rel}: ${call}`).toMatch(/\bsub=/);
      }
    }
  });
});
