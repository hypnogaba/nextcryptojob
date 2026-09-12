import { fetchJson, SourceUnavailableError } from "../http.js";
import type { AuditsFacts, Fetched } from "../types.js";
import { collect, describeError, fetchOpts, GapError, pause, type CollectorContext } from "./context.js";

/**
 * Аудит-конкурси через Sherlock (research/harness/collect_audits.py): JSON, яким користується
 * сам audits.sherlock.xyz, без ключа. Резюме Sherlock зводить конкурси й з інших платформ
 * (Code4rena, Cantina…), які людина сама привʼязала. Code4rena, Immunefi і Cantina напряму
 * не збираємо (docs/contracts.md §4, v5).
 *
 * Профіль приймається, лише якщо його github_handle або twitter_handle збігається з GitHub
 * або X людини (§2). /stats/stats не питаємо: сума payout у резюме збігається з його earnings.
 */
export const SHERLOCK = "https://mainnet-contest.sherlock.xyz";
/** Пауза між запитами до Sherlock для однієї людини (як PAUSE у дослідженні). */
export const SHERLOCK_PAUSE_MS = 2_500;

type Watson = { handle?: string; github_handle?: string | null; twitter_handle?: string | null };
export type ResumeEntry = {
  type?: string; provider?: string; payout?: number | null;
  issues?: Array<{ severity?: string | null }> | null;
};

/** Нік із профілю: без "@", без адреси перед ним, нижній регістр ("https://x.com/Foo/" → "foo"). */
export const normHandle = (s: string | null | undefined): string =>
  (s ?? "").trim().toLowerCase().replace(/^@/, "").replace(/\/+$/, "").split("/").pop() ?? "";

export function verifiedBy(p: Watson, person: { github?: string | null; x?: string | null }): "github" | "x" | null {
  const gh = normHandle(person.github), x = normHandle(person.x);
  if (gh && normHandle(p.github_handle) === gh) return "github";
  if (x && normHandle(p.twitter_handle) === x) return "x";
  return null;
}

/** Зведення резюме за постачальником: лише записи type = CONTEST, HIGH і CRITICAL разом. */
export function summarizeResume(resume: ResumeEntry[]): Pick<AuditsFacts, "earningsUsd" | "high" | "contests" | "providers"> {
  const providers: AuditsFacts["providers"] = {};
  for (const e of resume) {
    if (e?.type !== "CONTEST") continue;
    const p = (providers[e.provider || "UNKNOWN"] ??= { earningsUsd: 0, high: 0, medium: 0, contests: 0 });
    p.earningsUsd += typeof e.payout === "number" && Number.isFinite(e.payout) ? e.payout : 0;
    p.contests += 1;
    for (const i of e.issues ?? []) {
      const sev = (i?.severity ?? "").toUpperCase();
      if (sev === "HIGH" || sev === "CRITICAL") p.high += 1;
      else if (sev === "MEDIUM") p.medium += 1;
    }
  }
  const all = Object.values(providers);
  for (const p of all) p.earningsUsd = Math.round(p.earningsUsd * 100) / 100;
  return {
    earningsUsd: Math.round(all.reduce((s, p) => s + p.earningsUsd, 0) * 100) / 100,
    high: all.reduce((s, p) => s + p.high, 0),
    contests: all.reduce((s, p) => s + p.contests, 0),
    providers,
  };
}

export async function collectAudits(
  sherlockHandle: string,
  person: { github?: string | null; x?: string | null },
  ctx: CollectorContext,
): Promise<Fetched<AuditsFacts>> {
  return collect("audits", ctx, async () => {
    const handle = sherlockHandle.trim().replace(/^@/, "").toLowerCase();
    // Перший символ лише літера чи цифра: "." і ".." у шляху /watson/<h> вели б в інший ресурс.
    if (!/^[a-z0-9][a-z0-9_.-]{0,63}$/.test(handle)) throw new GapError("invalid Sherlock handle");
    if (!normHandle(person.github) && !normHandle(person.x)) {
      throw new GapError("no GitHub or X to verify the Sherlock profile against");
    }
    const opts = fetchOpts(ctx, { retries: 1, retryDelayMs: SHERLOCK_PAUSE_MS });
    const get = <T>(path: string): Promise<T> => fetchJson<T>(`${SHERLOCK}${path}`, { signal: ctx.signal }, opts);

    let profile: Watson;
    try {
      profile = await get<Watson>(`/watson/${encodeURIComponent(handle)}`);
    } catch (e) {
      if (e instanceof SourceUnavailableError && e.status === 404) throw new GapError("no Sherlock profile with this handle");
      throw e;
    }
    const by = verifiedBy(profile, person);
    if (!by) throw new GapError("Sherlock profile does not link this person's GitHub or X");

    await pause(ctx, SHERLOCK_PAUSE_MS);
    let resume: unknown;
    try {
      resume = await get<unknown>(`/stats/resume/${encodeURIComponent(profile.handle || handle)}`);
    } catch (e) {
      if (ctx.signal?.aborted) throw e;
      throw new GapError(`Sherlock resume unavailable (${describeError(e)})`);
    }
    if (!Array.isArray(resume)) throw new GapError("Sherlock resume in an unknown shape");
    const sum = summarizeResume(resume as ResumeEntry[]);
    // Профіль без жодного конкурсу не доказ слабкості: прогалина, а не нуль.
    if (!sum.contests) throw new GapError("verified Sherlock profile has no contests");
    return { ...sum, verifiedBy: by };
  });
}
