import { adminEmails } from "@/lib/auth/admin-list";
import { deliver, type Notifier, type OutgoingMessage } from "@/lib/crm/notify";
import type { JobsDb } from "@/lib/jobs-db";
import { escapeHtml, sendMessage } from "@/lib/telegram/send";
import { sqlTime } from "@/lib/time";
import { parseDbTime, scannerMissed } from "./job-sources";

/**
 * Сповіщення власнику (адміну) про те, що зламалось або чекає на нього.
 *
 * Кому: люди з ADMIN_EMAILS. Є users.telegram_id: повідомлення бота в особисті, інакше лист
 * на цю пошту (deliver з lib/crm/notify.ts: Telegram, а якщо не дійшло, пошта). Щотижневий
 * звіт (weekly.ts) іде обома каналами.
 *
 * Кожне сповіщення каже: що сталось, чому це важливо, що зробити, і дає посилання.
 * Дедуплікація: рядок owner_alerts (0021) на ключ; те саме сповіщення не частіше за його
 * вікно (типово 24 год). Ключ займаємо ДО надсилання (claimAlert): паралельні запуски не
 * шлють двічі, а збій доставки лише записується (error), без повтору щогодини.
 *
 * Що перевіряє щогодинний cron (collectAlerts):
 *   - нова заявка агенції (ще й одразу, коли її подали: app/company/(crm)/apply/actions.ts);
 *   - задача cron упала або запізнилась;
 *   - сканер вакансій: прогін не ok, пропущений плановий скан, джерело падає 2+ скани поспіль
 *     або вже dead; розвідка роботодавців упала чи не запускалась тиждень;
 *   - оплати x402 без результату (чекають повернення) і завислі;
 *   - сплеск збоїв добірки, або добірки не йдуть добу.
 * Персональних даних у текстах немає: лише назви компаній, джерел, числа й причини збоїв.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const DEFAULT_WINDOW_MS = DAY;
/** Джерело, що падає, згадуємо не частіше разу на тиждень: dead лишається dead тижнями. */
export const SOURCE_WINDOW_MS = 7 * DAY;
/** Задача cron запізнилась, якщо останній запуск старший за це (як CRON_LATE_AFTER_MS головної). */
export const CRON_LATE_MS: Record<string, number> = {
  "*/5 * * * *": 15 * MIN,
  "0 * * * *": 90 * MIN,
  "0 3 * * *": 26 * HOUR,
};
/** Сплеск збоїв добірки за добу: не менше стількох і не менше такої частки. */
export const DIGEST_FAIL_MIN = 5;
export const DIGEST_FAIL_SHARE = 0.2;
/** Розвідка роботодавців іде щонеділі; старше за це = таймер стоїть. */
export const DISCOVER_LATE_MS = 8 * DAY;
/** Прогін скану в стані running довше за це: завис. */
export const SCAN_STUCK_MS = 3 * HOUR;

export interface OwnerAlert {
  /** Ключ дедуплікації: 'agency:app_…', 'cron:jobs.expire', 'scan:<run id>'. */
  key: string;
  kind: string;
  title: string;
  why: string;
  next: string;
  /** Шлях в адмінці. */
  href: string;
  windowMs?: number;
  /** Рядки під заголовком (напр. список джерел). */
  details?: string[];
  /**
   * Складене сповіщення: кожен пункт займає свій ключ, і в повідомлення йдуть лише ті, що
   * зайнято зараз (джерела: кожне не частіше SOURCE_WINDOW_MS). Порожньо = не слати.
   */
  parts?: { key: string; line: string }[];
}

export interface OwnerRecipient {
  email: string;
  telegramId: string | null;
}

/** Адміни: пошти з ADMIN_EMAILS і їхні telegram_id, якщо акаунт є. */
export async function ownerRecipients(db: D1Database, rawAdminEmails: string | undefined): Promise<OwnerRecipient[]> {
  const emails = adminEmails(rawAdminEmails);
  const { results } = await db
    .prepare("SELECT email, telegram_id FROM users WHERE email IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(emails))
    .all<{ email: string; telegram_id: string | null }>();
  const tg = new Map(results.map((r) => [r.email.toLowerCase(), r.telegram_id]));
  return emails.map((email) => ({ email, telegramId: tg.get(email) ?? null }));
}

/** Текст сповіщення: Telegram (HTML) і лист. */
export function ownerAlertMessage(a: Pick<OwnerAlert, "title" | "why" | "next" | "href" | "details">, origin: string): OutgoingMessage {
  const url = new URL(a.href, origin).toString();
  const details = a.details ?? [];
  const tgDetails = details.length ? `\n${details.map((d) => `• ${escapeHtml(d)}`).join("\n")}` : "";
  const telegramHtml =
    `<b>${escapeHtml(a.title)}</b>${tgDetails}\n\n` +
    `<b>Why it matters:</b> ${escapeHtml(a.why)}\n` +
    `<b>What to do:</b> ${escapeHtml(a.next)}\n\n` +
    `<a href="${escapeHtml(url)}">Open in admin</a>`;
  const text =
    `${a.title}\n${details.map((d) => `- ${d}\n`).join("")}\n` +
    `Why it matters: ${a.why}\nWhat to do: ${a.next}\n\nOpen in admin: ${url}\n`;
  const html =
    `<p><b>${escapeHtml(a.title)}</b></p>` +
    (details.length ? `<ul>${details.map((d) => `<li>${escapeHtml(d)}</li>`).join("")}</ul>` : "") +
    `<p><b>Why it matters:</b> ${escapeHtml(a.why)}</p><p><b>What to do:</b> ${escapeHtml(a.next)}</p>` +
    `<p><a href="${escapeHtml(url)}">Open in admin</a></p>`;
  return { telegramHtml, email: { subject: `NextCryptoJob: ${a.title}`, text, html } };
}

/**
 * Зайняти ключ: true, якщо цього сповіщення не було довше за вікно (або не було зовсім).
 * Один UPSERT з умовою: два паралельні запуски не займуть ключ обидва.
 */
export async function claimAlert(
  db: D1Database,
  a: { key: string; kind: string; summary: string; windowMs?: number },
  now: Date,
): Promise<boolean> {
  const at = sqlTime(now);
  const cutoff = sqlTime(new Date(now.getTime() - (a.windowMs ?? DEFAULT_WINDOW_MS)));
  const res = await db
    .prepare(
      `INSERT INTO owner_alerts (key, kind, sent_at, summary) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET sent_at = excluded.sent_at, times = owner_alerts.times + 1,
         summary = excluded.summary, channel = NULL, error = NULL
       WHERE owner_alerts.sent_at <= ?`,
    )
    .bind(a.key, a.kind, at, a.summary.slice(0, 300), cutoff)
    .run();
  return (res.meta.changes ?? 0) > 0;
}

async function markAlert(db: D1Database, key: string, channel: string | null, error: string | null): Promise<void> {
  await db
    .prepare("UPDATE owner_alerts SET channel = ?, error = ? WHERE key = ?")
    .bind(channel, error ? error.slice(0, 300) : null, key)
    .run();
}

export type AlertDelivery = { sent: boolean; skipped?: "dedupe" | "no_recipient"; channels: string[]; error?: string };

/** Кожному адміну: Telegram, якщо є telegram_id, інакше пошта (deliver сам бере другий канал, коли перший не дійшов). */
export async function deliverToOwners(
  recipients: OwnerRecipient[],
  message: OutgoingMessage,
  notifier: Notifier,
  mode: "one" | "both" = "one",
): Promise<{ channels: string[]; errors: string[] }> {
  const channels = new Set<string>();
  const errors: string[] = [];
  for (const r of recipients) {
    if (mode === "both") {
      if (r.telegramId) {
        if (!notifier.botToken) errors.push("telegram: not configured: TELEGRAM_BOT_TOKEN");
        else {
          const res = await sendMessage(notifier.botToken, r.telegramId, message.telegramHtml, {}, notifier.send);
          if (res.ok) channels.add("telegram");
          else errors.push(`telegram: ${(res.description ?? "failed").slice(0, 120)}`);
        }
      }
      if (!notifier.mailer) errors.push("email: not configured: EMAIL");
      else {
        try {
          await notifier.mailer.send({ to: r.email, ...message.email });
          channels.add("email");
        } catch (e) {
          errors.push(`email: ${(e instanceof Error ? e.message || e.name : "failed").slice(0, 120)}`);
        }
      }
      continue;
    }
    const res = await deliver({ channel: r.telegramId ? "telegram" : "email", telegramId: r.telegramId, email: r.email }, message, notifier);
    if (res.ok) channels.add(res.channel);
    else errors.push(res.error);
  }
  return { channels: [...channels], errors };
}

/** Надіслати одне сповіщення з дедуплікацією. */
export async function sendOwnerAlert(
  db: D1Database,
  a: OwnerAlert,
  deps: { notifier: Notifier; adminEmails: string | undefined; now?: Date },
): Promise<AlertDelivery> {
  const now = deps.now ?? new Date();
  let details = a.details;
  if (a.parts) {
    const fresh: string[] = [];
    for (const p of a.parts) {
      if (await claimAlert(db, { key: p.key, kind: a.kind, summary: p.line, windowMs: a.windowMs }, now)) fresh.push(p.line);
    }
    if (fresh.length === 0) return { sent: false, skipped: "dedupe", channels: [] };
    details = [...fresh, ...(a.details ?? [])];
    // Складене сповіщення пишеться ще й під своїм ключем (для списку в адмінці), без вікна.
    await claimAlert(db, { key: a.key, kind: a.kind, summary: a.title, windowMs: 0 }, now);
  } else if (!(await claimAlert(db, { key: a.key, kind: a.kind, summary: a.title, windowMs: a.windowMs }, now))) {
    return { sent: false, skipped: "dedupe", channels: [] };
  }
  const recipients = await ownerRecipients(db, deps.adminEmails);
  if (recipients.length === 0) {
    await markAlert(db, a.key, null, "no admin recipient");
    return { sent: false, skipped: "no_recipient", channels: [] };
  }
  const { channels, errors } = await deliverToOwners(recipients, ownerAlertMessage({ ...a, details }, deps.notifier.origin), deps.notifier);
  const error = errors.length ? errors.join("; ") : null;
  await markAlert(db, a.key, channels.length ? channels.join(",") : null, error);
  if (channels.length === 0) console.error("owner alert not delivered", { key: a.key, error });
  return { sent: channels.length > 0, channels, ...(error ? { error } : {}) };
}

// ---------------------------------------------------------------------------
// Що перевіряти

type Row = Record<string, unknown>;
const num = (v: unknown): number => Number(v) || 0;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const cut = (s: unknown, n = 160) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Заявка агенції: окремо, щоб її можна було надіслати й одразу після подання. */
export function agencyAlert(app: { id: string; company: string; country: string | null; resubmitted?: boolean }): OwnerAlert {
  return {
    // Оновлена після "Ask for more info" заявка: новий ключ, бо це нова відповідь агенції.
    key: app.resubmitted ? `agency-update:${app.id}` : `agency:${app.id}`,
    kind: "agency",
    title: `${app.resubmitted ? "Agency application updated" : "New agency application"}: ${cut(app.company, 80)}${app.country ? ` (${app.country})` : ""}`,
    why: "The agency cannot search candidates until you approve it, and it is waiting for an answer.",
    next: "Open Agency applications, check the website and how they will use profiles, then approve, reject or ask for more info.",
    href: "/admin/agency-applications",
    windowMs: app.resubmitted ? DAY : 365 * DAY,
  };
}

/** Заявки агенцій, що чекають (за 14 днів): кожна один раз. */
async function agencyAlerts(db: D1Database, now: Date): Promise<OwnerAlert[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id, c.name, a.country FROM agency_applications a JOIN companies c ON c.id = a.company_id
        WHERE a.status = 'pending' AND a.created_at >= ? ORDER BY a.created_at LIMIT 20`,
    )
    .bind(sqlTime(new Date(now.getTime() - 14 * DAY)))
    .all<{ id: string; name: string; country: string | null }>();
  return results.map((r) => agencyAlert({ id: r.id, company: r.name, country: r.country }));
}

/** Задачі cron: останній запуск упав, або запуску давно не було. */
async function cronAlerts(db: D1Database, jobs: { job: string; cron: string }[], now: Date): Promise<OwnerAlert[]> {
  if (jobs.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT j.value AS job, c.started_at, c.ok, c.error,
              (SELECT COUNT(*) FROM cron_runs f WHERE f.job = j.value AND f.started_at >= ?2 AND f.ok = 0) AS failed_24h
         FROM json_each(?1) j
         LEFT JOIN cron_runs c ON c.id = (SELECT id FROM cron_runs WHERE job = j.value ORDER BY started_at DESC LIMIT 1)`,
    )
    .bind(JSON.stringify(jobs.map((j) => j.job)), sqlTime(new Date(now.getTime() - DAY)))
    .all<Row>();
  const byJob = new Map(results.map((r) => [String(r.job), r]));
  const out: OwnerAlert[] = [];
  for (const { job, cron } of jobs) {
    const r = byJob.get(job) ?? {};
    const last = parseDbTime(typeof r.started_at === "string" ? r.started_at : null);
    const lateAfter = CRON_LATE_MS[cron] ?? DAY;
    // Задача без жодного запуску ще нова (щойно додана): мовчимо. Мертвий тригер видно
    // з інших його задач, чий останній запуск старіє.
    const since = last;
    if (since !== null && now.getTime() - since > lateAfter) {
      out.push({
        key: `cron-late:${job}`,
        kind: "cron",
        title: `Scheduled job ${job} has not run for ${Math.round((now.getTime() - since) / HOUR)} h`,
        why: "The site's scheduled work (intro expiry, webhooks, saved-search alerts, cleanup) stops with it.",
        next: "Open Overview, Health. If every job is late, the Worker cron triggers are off: check the Cloudflare dashboard, Workers, nextcryptojob, Triggers, and the Worker logs.",
        href: "/admin#health",
      });
    } else if (num(r.ok) === 0 && r.ok !== null && r.ok !== undefined) {
      out.push({
        key: `cron:${job}`,
        kind: "cron",
        title: `Scheduled job ${job} failed`,
        details: [`Last error: ${cut(r.error) || "no message"}`, `Failures in 24 h: ${num(r.failed_24h)}`],
        why: "What this job does is not done until it succeeds; it retries on its next run.",
        next: "Open Overview, Health for the error. A database error that repeats needs a look at the Worker logs; one failure that the next run fixes needs nothing.",
        href: "/admin#health",
      });
    }
  }
  return out;
}

/** Оплати x402: без результату (чекають повернення) і завислі. */
async function paymentAlerts(db: D1Database, now: Date): Promise<OwnerAlert[]> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM x402_payments WHERE no_result_at IS NOT NULL AND refunded_at IS NULL) AS no_result,
              (SELECT COUNT(*) FROM x402_payments WHERE (status = 'verified' AND created_at < ?) OR status = 'unconfirmed') AS stale`,
    )
    .bind(sqlTime(new Date(now.getTime() - 5 * MIN)))
    .first<Row>();
  const out: OwnerAlert[] = [];
  if (num(row?.no_result) > 0) {
    out.push({
      key: "x402:no-result",
      kind: "payments",
      title: `Refund needed: ${plural(num(row?.no_result), "payment", "payments")} settled without a result`,
      why: "Someone paid in USDC and got nothing back. Refunds are promised in the terms.",
      next: "Open Payments, send the USDC back to the payer address shown there, then mark the payment refunded.",
      href: "/admin/payments",
    });
  }
  if (num(row?.stale) > 0) {
    out.push({
      key: "x402:stale",
      kind: "payments",
      title: `${plural(num(row?.stale), "x402 payment is", "x402 payments are")} stuck or unconfirmed`,
      why: "We do not know if the money moved. The payer may have been charged without a result.",
      next: "Open Payments and check each transaction in the explorer; settle or refund by hand.",
      href: "/admin/payments",
    });
  }
  return out;
}

/** Добірка: сплеск збоїв за добу або жодного прогону добу, хоча є кому слати. */
async function digestAlerts(db: D1Database, now: Date): Promise<OwnerAlert[]> {
  const row = await db
    .prepare(
      `SELECT COALESCE(SUM(status = 'sent'), 0) AS sent, COALESCE(SUM(status = 'failed'), 0) AS failed,
              (SELECT substr(COALESCE(NULLIF(error, ''), 'no reason recorded'), 1, 120) FROM digest_runs
                WHERE created_at >= ?1 AND status = 'failed' GROUP BY 1 ORDER BY COUNT(*) DESC LIMIT 1) AS reason,
              (SELECT MAX(created_at) FROM digest_runs) AS newest,
              (SELECT COUNT(*) FROM users u WHERE u.roles <> '[]' AND COALESCE(u.digest_paused, 0) = 0 AND u.is_demo = 0
                  AND EXISTS (SELECT 1 FROM scores s WHERE s.user_id = u.id)) AS eligible
         FROM digest_runs WHERE created_at >= ?1`,
    )
    .bind(sqlTime(new Date(now.getTime() - DAY)))
    .first<Row>();
  const out: OwnerAlert[] = [];
  const sent = num(row?.sent);
  const failed = num(row?.failed);
  if (failed >= DIGEST_FAIL_MIN && failed / Math.max(1, sent + failed) >= DIGEST_FAIL_SHARE) {
    out.push({
      key: "digest:failures",
      kind: "digest",
      title: `Daily digests failing: ${failed} of ${sent + failed} in 24 h`,
      details: [`Top reason: ${cut(row?.reason) || "no reason recorded"}`],
      why: "People who asked for jobs did not get them today.",
      next: "Open Overview, Daily digests, for the reasons. Email errors: check Cloudflare Email Service; Telegram 403: people blocked the bot (nothing to do); other errors: engine logs on the VPS (journalctl -u nextcryptojob-digest).",
      href: "/admin#digests",
    });
  }
  const newest = parseDbTime(typeof row?.newest === "string" ? row.newest : null);
  if (num(row?.eligible) > 0 && (newest === null || now.getTime() - newest > 26 * HOUR)) {
    out.push({
      key: "digest:idle",
      kind: "digest",
      title: `No digest run for ${newest === null ? "ever" : `${Math.round((now.getTime() - newest) / HOUR)} h`}`,
      why: `${plural(num(row?.eligible), "person is", "people are")} waiting for daily jobs and gets nothing.`,
      next: "The digest timer on the VPS is stopped: systemctl status nextcryptojob-digest.timer, then journalctl -u nextcryptojob-digest.",
      href: "/admin#digests",
    });
  }
  return out;
}

/** Сканер вакансій і розвідка роботодавців (база вакансій, лише читання). */
async function jobsAlerts(jobs: JobsDb, now: Date): Promise<OwnerAlert[]> {
  const out: OwnerAlert[] = [];
  const [scan] = await jobs.all<Row>(
    `SELECT id, status, started_at, sources_ok, sources_failed, jobs_found, notes FROM scan_runs
      WHERE kind = 'scan' ORDER BY started_at DESC LIMIT 1`,
  );
  const scanAt = parseDbTime(typeof scan?.started_at === "string" ? scan.started_at : null);
  if (scannerMissed(scanAt, now)) {
    out.push({
      key: "scan:missed",
      kind: "scan",
      title: "Job scanner missed its daily run",
      details: [scanAt === null ? "No scan recorded." : `Last scan ${Math.round((now.getTime() - scanAt) / HOUR)} h ago.`],
      why: "No new jobs come in, and in 3 days the digests run out of live jobs.",
      next: "On the VPS: systemctl status nextcryptojob-jobs-scan.timer and journalctl -u nextcryptojob-jobs-scan. Run it by hand with systemctl start nextcryptojob-jobs-scan.",
      href: "/admin/sources",
    });
  } else if (scan && scan.status === "running" && scanAt !== null && now.getTime() - scanAt > SCAN_STUCK_MS) {
    out.push({
      key: `scan-stuck:${String(scan.id)}`,
      kind: "scan",
      title: "Job scan is stuck",
      details: [`Started ${Math.round((now.getTime() - scanAt) / HOUR)} h ago and has not finished.`],
      why: "The process probably died; today's jobs are not saved.",
      next: "On the VPS: journalctl -u nextcryptojob-jobs-scan for the reason, then systemctl start nextcryptojob-jobs-scan.",
      href: "/admin/sources",
    });
  } else if (scan && (scan.status === "failed" || scan.status === "partial")) {
    let error = "";
    try {
      const notes = JSON.parse(String(scan.notes ?? "{}")) as { error?: string };
      error = notes.error ?? "";
    } catch {
      // Нотатки не JSON: без причини.
    }
    out.push({
      key: `scan:${String(scan.id)}`,
      kind: "scan",
      title: scan.status === "failed" ? "Job scan failed" : "Job scan was only partly done",
      details: [
        `${num(scan.sources_ok)} sources read, ${num(scan.sources_failed)} failed, ${num(scan.jobs_found)} jobs kept.`,
        ...(error ? [`Error: ${cut(error)}`] : []),
      ],
      why: scan.status === "failed" ? "No jobs were saved in this run." : "Many sources failed at once: usually a network or rate-limit problem, not the sources.",
      next: "Open Job sources for the failing ones. If it repeats tomorrow, check journalctl -u nextcryptojob-jobs-scan on the VPS.",
      href: "/admin/sources",
    });
  }

  const failing = await jobs.all<Row>(
    `SELECT source, status, fail_days, last_error FROM source_state
      WHERE status = 'dead' OR fail_days >= 2 ORDER BY status = 'dead', fail_days DESC, source LIMIT 60`,
  );
  if (failing.length > 0) {
    out.push({
      key: `sources:${now.toISOString().slice(0, 10)}`,
      kind: "source",
      title: `Job sources not working: ${failing.length}`,
      windowMs: SOURCE_WINDOW_MS,
      parts: failing.map((s) => ({
        key: `source:${String(s.source)}`,
        line: `${String(s.source)}: ${s.status === "dead" ? "dead, read once a week" : `failing ${num(s.fail_days)} scans in a row`}${s.last_error ? ` (${cut(s.last_error, 80)})` : ""}`,
      })),
      why: "Jobs from these employers or boards stop coming in; after 7 failing days a source is only retried weekly.",
      next: "Open Job sources, Problems. Open the board link: if the page is gone or moved to another ATS, change the company in the jobs registry (db/jobs, companies) or disable it; a timeout that heals by itself needs nothing.",
      href: "/admin/sources#problems",
    });
  }

  const [disc] = await jobs.all<Row>(
    `SELECT id, status, started_at, jobs_new, notes FROM scan_runs WHERE kind = 'discover' ORDER BY started_at DESC LIMIT 1`,
  );
  const discAt = parseDbTime(typeof disc?.started_at === "string" ? disc.started_at : null);
  if (disc && disc.status === "failed") {
    let error = "";
    try {
      error = (JSON.parse(String(disc.notes ?? "{}")) as { error?: string }).error ?? "";
    } catch {
      // без причини
    }
    out.push({
      key: `discover:${String(disc.id)}`,
      kind: "discover",
      title: "Weekly employer discovery failed",
      details: error ? [`Error: ${cut(error)}`] : undefined,
      why: "New companies from the ecosystem and fund boards are not added this week.",
      next: "On the VPS: journalctl -u nextcryptojob-jobs-discover. It runs again next Sunday; start it by hand with systemctl start nextcryptojob-jobs-discover.",
      href: "/admin/sources#boards",
      windowMs: 30 * DAY,
    });
  } else if (disc) {
    let boardErrors: string[] = [];
    try {
      const notes = JSON.parse(String(disc.notes ?? "{}")) as { getro?: { label?: string; error?: string }[] | null };
      boardErrors = (notes.getro ?? []).filter((g) => g.error).map((g) => `${cut(g.label, 40)}: ${cut(g.error, 80)}`);
    } catch {
      // без нотаток
    }
    if (boardErrors.length) {
      out.push({
        key: `discover-boards:${String(disc.id)}`,
        kind: "discover",
        title: `Discovery could not read ${plural(boardErrors.length, "board", "boards")}`,
        details: boardErrors.slice(0, 10),
        why: "Companies from these boards are not checked this week.",
        next: "Open the board page: if it moved or changed platform, update db/jobs/seed/boards.json and the job_boards row.",
        href: "/admin/sources#boards",
        windowMs: 30 * DAY,
      });
    }
  }
  if (discAt !== null && now.getTime() - discAt > DISCOVER_LATE_MS) {
    out.push({
      key: "discover:missed",
      kind: "discover",
      title: `Weekly employer discovery has not run for ${Math.round((now.getTime() - discAt) / DAY)} days`,
      why: "New companies from boards and speedrun stop coming in.",
      next: "On the VPS: systemctl status nextcryptojob-jobs-discover.timer (Sundays 05:30 UTC).",
      href: "/admin/sources#boards",
      windowMs: 7 * DAY,
    });
  }
  return out;
}

export interface CollectOptions {
  jobs: JobsDb | null;
  /** Задачі розкладу (назва й тригер) з lib/cron: сюди не імпортуємо, щоб не було кола модулів. */
  cronJobs: { job: string; cron: string }[];
  now?: Date;
}

/** Усі сповіщення, які варто надіслати зараз (дедуплікацію робить sendOwnerAlert). Збій однієї перевірки не зупиняє решти. */
export async function collectAlerts(db: D1Database, o: CollectOptions): Promise<{ alerts: OwnerAlert[]; errors: string[] }> {
  const now = o.now ?? new Date();
  const checks: [string, () => Promise<OwnerAlert[]>][] = [
    ["agency", () => agencyAlerts(db, now)],
    ["cron", () => cronAlerts(db, o.cronJobs, now)],
    ["payments", () => paymentAlerts(db, now)],
    ["digest", () => digestAlerts(db, now)],
  ];
  if (o.jobs) checks.push(["jobs", () => jobsAlerts(o.jobs!, now)]);
  const alerts: OwnerAlert[] = [];
  const errors: string[] = [];
  for (const [name, run] of checks) {
    try {
      alerts.push(...(await run()));
    } catch (e) {
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { alerts, errors };
}

export interface OwnerAlertsResult {
  checked: number;
  sent: number;
  deduped: number;
  failed: number;
  checkErrors: number;
}

/** Щогодинна задача cron: зібрати й надіслати. */
export async function runOwnerAlerts(
  db: D1Database,
  deps: CollectOptions & { notifier: Notifier; adminEmails: string | undefined },
): Promise<OwnerAlertsResult> {
  const now = deps.now ?? new Date();
  const { alerts, errors } = await collectAlerts(db, { ...deps, now });
  const out: OwnerAlertsResult = { checked: alerts.length, sent: 0, deduped: 0, failed: 0, checkErrors: errors.length };
  for (const e of errors) console.error("owner alerts: check failed", e);
  for (const a of alerts) {
    const res = await sendOwnerAlert(db, a, { notifier: deps.notifier, adminEmails: deps.adminEmails, now });
    if (res.sent) out.sent++;
    else if (res.skipped === "dedupe") out.deduped++;
    else out.failed++;
  }
  return out;
}

export type RecentAlert = { key: string; kind: string; summary: string | null; sentAt: number | null; times: number; channel: string | null; error: string | null };

/** Останні сповіщення для головної адмінки. */
export async function recentAlerts(db: D1Database, limit = 8): Promise<RecentAlert[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT key, kind, summary, sent_at, times, channel, error FROM owner_alerts
          WHERE key NOT LIKE 'source:%' ORDER BY sent_at DESC LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();
    return results.map((r) => ({
      key: String(r.key),
      kind: String(r.kind),
      summary: typeof r.summary === "string" ? r.summary : null,
      sentAt: parseDbTime(typeof r.sent_at === "string" ? r.sent_at : null),
      times: num(r.times),
      channel: typeof r.channel === "string" ? r.channel : null,
      error: typeof r.error === "string" ? r.error : null,
    }));
  } catch {
    return [];
  }
}
