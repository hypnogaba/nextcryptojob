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
});
