import type { Notifier, OutgoingMessage } from "@/lib/crm/notify";
import type { JobsDb } from "@/lib/jobs-db";
import { escapeHtml } from "@/lib/telegram/send";
import { sqlTime } from "@/lib/time";
import { claimAlert, deliverToOwners, ownerRecipients } from "./alerts";

/**
 * Щотижневий звіт власнику: щопонеділка о WEEKLY_HOUR_UTC:00 UTC, Telegram і пошта разом.
 * Щогодинний cron (lib/cron) кличе runWeeklyReport; той шле, коли зараз понеділок, година
 * не раніша за WEEKLY_HOUR_UTC і звіту цього тижня ще не було (ключ 'weekly:<дата понеділка>'
 * в owner_alerts). Тож збій о 08:00 добере запуск о 09:00. Кнопка на /admin шле звіт одразу
 * (preview), не займаючи понеділкового ключа.
 *
 * Звіт за 7 днів до миті надсилання: відвідування й нові люди (з попереднім тижнем для
 * порівняння), скільки нових пройшли анкету, добірки, компанії й знайомства, що чекає на
 * адміна (заявки агенцій, черга X, повернення), і проблеми (джерела, скани, cron, добірки).
 * Демо (is_demo) не рахується ніде.
 */

export const WEEKLY_DAY_UTC = 1; // понеділок
export const WEEKLY_HOUR_UTC = 8;

const DAY = 86_400_000;

export interface WeeklyReport {
  from: string;
  to: string;
  visitors: { views: number; uniques: number; prevUniques: number } | null;
  users: { newUsers: number; prevNewUsers: number; briefDone: number; total: number };
  digests: { sent: number; failed: number; empty: number };
  companies: { newCompanies: number; active: number; searches: number; intros: number; accepted: number };
  requests: { agencies: number; xQueue: number; refunds: number; stalePayments: number };
  problems: {
    cronFailures: { job: string; n: number }[];
    scans: { runs: number; notOk: number } | null;
    failingSources: number | null;
    deadSources: number | null;
    digestFailed: number;
  };
}

type Row = Record<string, unknown>;
const num = (v: unknown) => Number(v) || 0;

function json<T>(v: unknown, fallback: T): T {
  if (typeof v !== "string") return fallback;
  try {
    return (JSON.parse(v) as T) ?? fallback;
  } catch {
    return fallback;
  }
}

/** Понеділок (дата UTC) тижня, у якому лежить `now`. */
export function weekStart(now: Date): string {
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/** Чи час слати звіт цього тижня (понеділок, не раніше WEEKLY_HOUR_UTC). */
export function weeklyDue(now: Date): boolean {
  return now.getUTCDay() === WEEKLY_DAY_UTC && now.getUTCHours() >= WEEKLY_HOUR_UTC;
}

/** Один запит на основну базу (скалярні підзапити) і два на базу вакансій, якщо вона є. */
export async function loadWeeklyReport(db: D1Database, jobs: JobsDb | null, now: Date = new Date()): Promise<WeeklyReport> {
  const t7 = sqlTime(new Date(now.getTime() - 7 * DAY));
  const t14 = sqlTime(new Date(now.getTime() - 14 * DAY));
  const d7 = new Date(now.getTime() - 7 * DAY).toISOString().slice(0, 10);
  const d14 = new Date(now.getTime() - 14 * DAY).toISOString().slice(0, 10);
  const r =
    (await db
      .prepare(
        `SELECT
          (SELECT COUNT(*) FROM users WHERE created_at >= ?1 AND is_demo = 0) AS new_users,
          (SELECT COUNT(*) FROM users WHERE created_at >= ?2 AND created_at < ?1 AND is_demo = 0) AS prev_new_users,
          (SELECT COUNT(*) FROM users u WHERE u.created_at >= ?1 AND u.is_demo = 0
              AND u.onboarding_step IN ('x', 'wallets', 'sources', 'done')
              AND EXISTS (SELECT 1 FROM consents c WHERE c.user_id = u.id AND c.kind = 'scoring' AND c.granted = 1)) AS brief_done,
          (SELECT COUNT(*) FROM users WHERE is_demo = 0) AS total_users,
          (SELECT json_object('sent', COALESCE(SUM(status = 'sent'), 0), 'failed', COALESCE(SUM(status = 'failed'), 0),
                              'empty', COALESCE(SUM(status = 'empty'), 0))
             FROM digest_runs WHERE created_at >= ?1) AS digests,
          (SELECT COUNT(*) FROM companies WHERE created_at >= ?1 AND is_demo = 0) AS new_companies,
          (SELECT COUNT(*) FROM companies c JOIN company_access a ON a.company_id = c.id
            WHERE c.is_demo = 0 AND a.access = 'subscription') AS active_companies,
          (SELECT COUNT(*) FROM usage_events e WHERE e.created_at >= ?1 AND e.action = 'search_candidates'
              AND e.status BETWEEN 200 AND 299
              AND (e.company_id IS NULL OR e.company_id NOT IN (SELECT id FROM companies WHERE is_demo = 1))) AS searches,
          (SELECT COUNT(*) FROM intros i WHERE i.created_at >= ?1
              AND i.company_id NOT IN (SELECT id FROM companies WHERE is_demo = 1)) AS intros,
          (SELECT COUNT(*) FROM intros i WHERE i.responded_at >= ?1 AND i.status IN ('accepted', 'direct')
              AND i.company_id NOT IN (SELECT id FROM companies WHERE is_demo = 1)) AS accepted,
          (SELECT COUNT(*) FROM agency_applications WHERE status IN ('pending', 'needs_info')) AS agencies,
          (SELECT COUNT(*) FROM company_jobs j WHERE j.x_post_state = 'queued'
              AND j.company_id NOT IN (SELECT id FROM companies WHERE is_demo = 1)) AS x_queue,
          (SELECT COUNT(*) FROM x402_payments WHERE no_result_at IS NOT NULL AND refunded_at IS NULL) AS refunds,
          (SELECT COUNT(*) FROM x402_payments WHERE status = 'unconfirmed') AS stale_payments,
          (SELECT json_group_array(json_array(job, n)) FROM (
             SELECT job, COUNT(*) AS n FROM cron_runs WHERE started_at >= ?1 AND ok = 0 GROUP BY job ORDER BY n DESC LIMIT 5)) AS cron_failures`,
      )
      .bind(t7, t14)
      .first<Row>()) ?? {};

  let visitors: WeeklyReport["visitors"] = null;
  try {
    const v = await db
      .prepare(
        `SELECT COALESCE(SUM(CASE WHEN day >= ?1 THEN views END), 0) AS views,
                COALESCE(SUM(CASE WHEN day >= ?1 THEN uniques END), 0) AS uniques,
                COALESCE(SUM(CASE WHEN day < ?1 THEN uniques END), 0) AS prev
           FROM visit_days WHERE day >= ?2`,
      )
      .bind(d7, d14)
      .first<Row>();
    visitors = { views: num(v?.views), uniques: num(v?.uniques), prevUniques: num(v?.prev) };
  } catch {
    // Лічильника ще немає (0020): звіт без відвідувань.
  }

  let scans: WeeklyReport["problems"]["scans"] = null;
  let failingSources: number | null = null;
  let deadSources: number | null = null;
  if (jobs) {
    try {
      const [s] = await jobs.all<Row>(
        `SELECT COUNT(*) AS runs, COALESCE(SUM(status <> 'ok'), 0) AS not_ok FROM scan_runs
          WHERE kind = 'scan' AND started_at >= ? AND status <> 'running'`,
        new Date(now.getTime() - 7 * DAY).toISOString(),
      );
      scans = { runs: num(s?.runs), notOk: num(s?.not_ok) };
      const [f] = await jobs.all<Row>(
        "SELECT COALESCE(SUM(status = 'failing' AND fail_days >= 2), 0) AS failing, COALESCE(SUM(status = 'dead'), 0) AS dead FROM source_state",
      );
      failingSources = num(f?.failing);
      deadSources = num(f?.dead);
    } catch {
      // База вакансій не відповіла: звіт без цього блоку.
    }
  }

  const digests = json<{ sent?: number; failed?: number; empty?: number }>(r.digests, {});
  return {
    from: new Date(now.getTime() - 7 * DAY).toISOString().slice(0, 10),
    to: now.toISOString().slice(0, 10),
    visitors,
    users: { newUsers: num(r.new_users), prevNewUsers: num(r.prev_new_users), briefDone: num(r.brief_done), total: num(r.total_users) },
    digests: { sent: num(digests.sent), failed: num(digests.failed), empty: num(digests.empty) },
    companies: {
      newCompanies: num(r.new_companies),
      active: num(r.active_companies),
      searches: num(r.searches),
      intros: num(r.intros),
      accepted: num(r.accepted),
    },
    requests: { agencies: num(r.agencies), xQueue: num(r.x_queue), refunds: num(r.refunds), stalePayments: num(r.stale_payments) },
    problems: {
      cronFailures: json<[string, number][]>(r.cron_failures, []).map(([job, n]) => ({ job: String(job), n: num(n) })),
      scans,
      failingSources,
      deadSources,
      digestFailed: num(digests.failed),
    },
  };
}

function trend(now: number, prev: number): string {
  if (prev === 0) return now === 0 ? "" : " (new)";
  const p = Math.round((100 * (now - prev)) / prev);
  return ` (${p >= 0 ? "+" : ""}${p}% vs the week before)`;
}

function pct(n: number, of: number): string {
  return of > 0 ? `${Math.round((100 * n) / of)}%` : "0%";
}

/** Розділи звіту рядками: однакові для Telegram, листа й прев'ю в адмінці. */
/** «1 source», «3 sources». */
const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function weeklyLines(r: WeeklyReport): { title: string; sections: { head: string; lines: string[] }[] } {
  const problems: string[] = [];
  const p = r.problems;
  if (p.failingSources) problems.push(`${n(p.failingSources, "job source", "job sources")} failing 2+ scans in a row`);
  if (p.deadSources) problems.push(`${n(p.deadSources, "job source", "job sources")} dead (read once a week)`);
  if (p.scans && p.scans.notOk) problems.push(`${p.scans.notOk} of ${n(p.scans.runs, "job scan", "job scans")} not ok`);
  if (p.scans && p.scans.runs === 0) problems.push("No job scan this week");
  for (const c of p.cronFailures) problems.push(`Scheduled job ${c.job} failed ${n(c.n, "time", "times")}`);
  if (p.digestFailed) problems.push(`${n(p.digestFailed, "digest", "digests")} failed`);

  const requests: string[] = [];
  const q = r.requests;
  if (q.agencies) requests.push(`${n(q.agencies, "agency application", "agency applications")} to review`);
  if (q.xQueue) requests.push(`${n(q.xQueue, "job", "jobs")} waiting to be posted on X`);
  if (q.refunds) requests.push(`${n(q.refunds, "x402 payment", "x402 payments")} to refund`);
  if (q.stalePayments) requests.push(`${n(q.stalePayments, "x402 payment", "x402 payments")} unconfirmed`);

  const u = r.users;
  return {
    title: `NextCryptoJob weekly report, ${r.from} to ${r.to}`,
    sections: [
      {
        head: "Visitors",
        lines: r.visitors
          ? [
              `${r.visitors.uniques} unique visitors${trend(r.visitors.uniques, r.visitors.prevUniques)}`,
              `${r.visitors.views} page views`,
              `Visit to sign-up: ${pct(u.newUsers, r.visitors.uniques)}`,
            ]
          : ["Not counted yet (migration 0020)."],
      },
      {
        head: "People",
        lines: [
          `${u.newUsers} new sign-ups${trend(u.newUsers, u.prevNewUsers)}, ${u.total} in total`,
          `${u.briefDone} of ${u.newUsers} new people finished the brief (${pct(u.briefDone, u.newUsers)})`,
          `Digests: ${r.digests.sent} sent, ${r.digests.failed} failed, ${r.digests.empty} with no jobs`,
        ],
      },
      {
        head: "Companies",
        lines: [
          `${r.companies.newCompanies} new, ${r.companies.active} with access`,
          `${r.companies.searches} searches, ${r.companies.intros} intro requests, ${r.companies.accepted} contacts shared`,
        ],
      },
      { head: "Waiting for you", lines: requests.length ? requests : ["Nothing."] },
      { head: "Problems", lines: problems.length ? problems : ["None."] },
    ],
  };
}

export function weeklyMessage(r: WeeklyReport, origin: string): OutgoingMessage {
  const { title, sections } = weeklyLines(r);
  const url = new URL("/admin", origin).toString();
  const telegramHtml =
    `<b>${escapeHtml(title)}</b>\n\n` +
    sections.map((s) => `<b>${escapeHtml(s.head)}</b>\n${s.lines.map((l) => `• ${escapeHtml(l)}`).join("\n")}`).join("\n\n") +
    `\n\n<a href="${escapeHtml(url)}">Open admin</a>`;
  const text = `${title}\n\n${sections.map((s) => `${s.head}\n${s.lines.map((l) => `- ${l}`).join("\n")}`).join("\n\n")}\n\nOpen admin: ${url}\n`;
  const html =
    `<p><b>${escapeHtml(title)}</b></p>` +
    sections.map((s) => `<p><b>${escapeHtml(s.head)}</b></p><ul>${s.lines.map((l) => `<li>${escapeHtml(l)}</li>`).join("")}</ul>`).join("") +
    `<p><a href="${escapeHtml(url)}">Open admin</a></p>`;
  return { telegramHtml, email: { subject: title, text, html } };
}

export interface WeeklyResult {
  sent: boolean;
  skipped?: "not_due" | "already_sent" | "no_recipient";
  channels: string[];
  errors: string[];
}

/**
 * Надіслати звіт. force = кнопка в адмінці: зараз, без перевірки часу й без понеділкового
 * ключа (пишеться під 'weekly-preview', щоб його було видно в списку сповіщень).
 */
export async function runWeeklyReport(
  db: D1Database,
  deps: { jobs: JobsDb | null; notifier: Notifier; adminEmails: string | undefined; now?: Date; force?: boolean },
): Promise<WeeklyResult> {
  const now = deps.now ?? new Date();
  if (!deps.force && !weeklyDue(now)) return { sent: false, skipped: "not_due", channels: [], errors: [] };
  const key = deps.force ? "weekly-preview" : `weekly:${weekStart(now)}`;
  const claimed = await claimAlert(
    db,
    { key, kind: "weekly", summary: deps.force ? "Weekly report (sent from admin)" : `Weekly report, week of ${weekStart(now)}`, windowMs: deps.force ? 0 : 6 * DAY },
    now,
  );
  if (!claimed) return { sent: false, skipped: "already_sent", channels: [], errors: [] };
  const recipients = await ownerRecipients(db, deps.adminEmails);
  if (recipients.length === 0) return { sent: false, skipped: "no_recipient", channels: [], errors: [] };
  const report = await loadWeeklyReport(db, deps.jobs, now);
  const { channels, errors } = await deliverToOwners(recipients, weeklyMessage(report, deps.notifier.origin), deps.notifier, "both");
  await db
    .prepare("UPDATE owner_alerts SET channel = ?, error = ? WHERE key = ?")
    .bind(channels.length ? channels.join(",") : null, errors.length ? errors.join("; ").slice(0, 300) : null, key)
    .run();
  return { sent: channels.length > 0, channels, errors };
}
