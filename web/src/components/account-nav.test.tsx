import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { AccountShell } from "./account-nav";

/**
 * Власник 16.09, п.1: кабінет кандидата не пропонує створити компанію (кнопка живе на /company).
 * Власник 17.09 скасував п.6 від 16.09: «Saved jobs» знову окремий пункт, але підпунктом під
 * «Your jobs», бо список збережених робив сторінку /jobs дуже довгою. І «Your jobs» тепер перший
 * пункт меню, вище за все інше.
 */
describe("account cabinet side menu", () => {
  it("has no 'create a company' entry, and jobs first with saved under it", () => {
    const html = renderToStaticMarkup(
      <AccountShell active="overview" title="Account">
        <p>content</p>
      </AccountShell>,
    );
    expect(html).not.toMatch(/Company account/i);
    expect(html).not.toContain('href="/company/start"');

    const jobsLinks = html.match(/href="\/jobs"/g) ?? [];
    expect(jobsLinks).toHaveLength(1);
    // Власник 17.09: вакансії першим пунктом, збережені одразу під ними, і лише вони з acct-sub.
    const order = [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]);
    expect(order.slice(0, 2)).toEqual(["/jobs", "/jobs/saved"]);
    expect(html).toMatch(/acct-item acct-sub"[^>]*>Saved jobs/);
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
    // Один клас на всі пункти, окрім підпункту: він додає лише acct-sub (той самий рядок, тихіший).
    expect(new Set(items.filter((c) => !c.includes("acct-sub"))).size).toBe(1);
    expect(items.filter((c) => c.includes("acct-sub"))).toHaveLength(1);
  });

  /**
   * Власник 17.09: «зроби щоб все було однаково, не рухалося вверх-вниз». Шапка (заголовок і
   * підзаголовок) живе в блоці незмінної висоти, тож меню починається на тій самій висоті на
   * кожній сторінці кабінету, хоч із заголовком, хоч без нього, хоч із довгим, хоч із коротким.
   */
  it("reserves the same head height on every page, with or without a title", () => {
    const heads = [
      <AccountShell key="a" active="overview" title="Account" sub="Your card, your jobs and your settings, in one place.">
        <p>content</p>
      </AccountShell>,
      <AccountShell key="b" active="card" title="Your card and score" sub="Your score, your sources and your card, explained.">
        <p>content</p>
      </AccountShell>,
      <AccountShell key="c" active="answers">
        <p>content</p>
      </AccountShell>,
    ].map((el) => renderToStaticMarkup(el).match(/class="grid content-start ([^"]+)"/)?.[1]);
    expect(heads[0]).toBeTruthy();
    expect(new Set(heads).size).toBe(1);
    expect(heads[0]).toMatch(/min-h-/);
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
      "src/app/jobs/saved/page.tsx",
      "src/app/settings/page.tsx",
      // Власник 17.09: правка відповідей теж у кабінеті, і теж зі своєю шапкою, інакше меню
      // стоїть там вище, ніж на решті сторінок.
      "src/app/welcome/page.tsx",
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
