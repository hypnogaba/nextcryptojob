import { auditValues, guardedAuditStatement } from "@/lib/crm/audit";
import { sqlTime } from "@/lib/time";

/**
 * Адмінка вакансій компаній (специфікація CRM 12): "Hide" / "Unhide" (hidden_by_admin_at)
 * і черга постів для X-акаунта проєкту ("X queue": текст, "Copy", "Mark as posted" з
 * посиланням, "Skip"). Вакансії публікуються одразу (DECISIONS 12.09), адмін лише ховає.
 *
 * Кожна дія пише audit_log з актором admin у тому самому пакеті, що й зміна, і лише
 * якщо зміна справді відбулась (changes() = 1): подвійне натискання не дає двох рядків.
 */

export type AdminJobError = "not_admin" | "not_found" | "bad_url";

type Result = { ok: true } | { ok: false; reason: AdminJobError };

export interface AdminJobRow {
  id: string;
  title: string;
  status: "draft" | "open" | "closed";
  companyId: string;
  companyName: string;
  live: boolean;
  hiddenAt: string | null;
  publishedAt: string | null;
  expiresAt: string | null;
  digestShown: number;
  applyClicks: number;
}

/** Найбільше рядків на сторінці адмінки. */
export const ADMIN_JOBS_LIMIT = 200;

/** Відкриті й приховані вакансії, найновіші першими (закриті й чернетки нікому не видно, їх не показуємо). */
export async function listAdminJobs(db: D1Database): Promise<AdminJobRow[]> {
  const { results } = await db
    .prepare(
      `SELECT j.id, j.title, j.status, j.company_id, c.name AS company_name, j.hidden_by_admin_at, j.published_at, j.expires_at,
              j.digest_shown, j.apply_clicks, EXISTS (SELECT 1 FROM company_jobs_live l WHERE l.id = j.id) AS live
         FROM company_jobs j JOIN companies c ON c.id = j.company_id
        WHERE j.status = 'open' OR j.hidden_by_admin_at IS NOT NULL
        ORDER BY (j.hidden_by_admin_at IS NOT NULL) DESC, COALESCE(j.published_at, j.created_at) DESC, j.id
        LIMIT ?`,
    )
    .bind(ADMIN_JOBS_LIMIT)
    .all<{
      id: string;
      title: string;
      status: AdminJobRow["status"];
      company_id: string;
      company_name: string;
      hidden_by_admin_at: string | null;
      published_at: string | null;
      expires_at: string | null;
      digest_shown: number;
      apply_clicks: number;
      live: number;
    }>();
  return results.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.status,
    companyId: r.company_id,
    companyName: r.company_name,
    live: r.live === 1,
    hiddenAt: r.hidden_by_admin_at,
    publishedAt: r.published_at,
    expiresAt: r.expires_at,
    digestShown: r.digest_shown,
    applyClicks: r.apply_clicks,
  }));
}

function adminCtx(db: D1Database, adminUserId: string, now: Date) {
  return {
    db,
    actor: { kind: "admin" as const, userId: adminUserId },
    company: null,
    channel: "web" as const,
    requestId: crypto.randomUUID(),
    now,
  };
}

/** Одна зміна рядка вакансії й журнал за нею одним пакетом; ok, лише коли рядок змінився. */
async function change(
  db: D1Database,
  input: { jobId: string; adminUserId: string; now?: Date },
  update: { sql: string; params: (string | null)[] },
  action: string,
  meta: Record<string, string | null> = {},
): Promise<Result> {
  const now = input.now ?? new Date();
  const company = await db.prepare("SELECT company_id FROM company_jobs WHERE id = ?").bind(input.jobId).first<{ company_id: string }>();
  if (!company) return { ok: false, reason: "not_found" };
  const [updated] = await db.batch([
    db.prepare(update.sql).bind(...update.params),
    guardedAuditStatement(
      db,
      auditValues(adminCtx(db, input.adminUserId, now), { action, meta: { job_id: input.jobId, company_id: company.company_id, ...meta } }),
      { sql: "changes() = 1", params: [] },
    ),
  ]);
  return updated.meta.changes === 1 ? { ok: true } : { ok: false, reason: "not_found" };
}

/**
 * "Hide" / "Unhide": прихована вакансія одразу зникає з company_jobs_live, тобто з
 * добірок, search_jobs, публічної сторінки й черги X. Компанія бачить "Hidden by NextCryptoJob".
 */
export async function setJobHidden(db: D1Database, input: { jobId: string; adminUserId: string; hidden: boolean; now?: Date }): Promise<Result> {
  const at = sqlTime(input.now ?? new Date());
  return input.hidden
    ? change(
        db,
        input,
        { sql: "UPDATE company_jobs SET hidden_by_admin_at = ? WHERE id = ? AND hidden_by_admin_at IS NULL", params: [at, input.jobId] },
        "job.hide",
      )
    : change(
        db,
        input,
        { sql: "UPDATE company_jobs SET hidden_by_admin_at = NULL WHERE id = ? AND hidden_by_admin_at IS NOT NULL", params: [input.jobId] },
        "job.unhide",
      );
}

export interface XQueueRow {
  id: string;
  title: string;
  companyName: string;
  text: string;
  queuedAt: string | null;
}

export interface XPostedRow {
  id: string;
  title: string;
  companyName: string;
  url: string | null;
  postedAt: string | null;
}

/** Черга X: лише живі вакансії (чернетка з галочкою чекає публікації), найдавніші першими. */
export async function listXQueue(db: D1Database): Promise<XQueueRow[]> {
  const { results } = await db
    .prepare(
      `SELECT j.id, j.title, c.name AS company_name, j.x_post_text, j.x_queued_at
         FROM company_jobs j JOIN companies c ON c.id = j.company_id
        WHERE j.x_post_state = 'queued' AND j.x_post_text IS NOT NULL
          AND EXISTS (SELECT 1 FROM company_jobs_live l WHERE l.id = j.id)
        ORDER BY j.x_queued_at, j.id
        LIMIT 100`,
    )
    .all<{ id: string; title: string; company_name: string; x_post_text: string; x_queued_at: string | null }>();
  return results.map((r) => ({ id: r.id, title: r.title, companyName: r.company_name, text: r.x_post_text, queuedAt: r.x_queued_at }));
}

/** Останні опубліковані пости (для звірки, що посилання правильні). */
export async function listRecentXPosts(db: D1Database, limit = 20): Promise<XPostedRow[]> {
  const { results } = await db
    .prepare(
      `SELECT j.id, j.title, c.name AS company_name, j.x_post_url, j.x_posted_at
         FROM company_jobs j JOIN companies c ON c.id = j.company_id
        WHERE j.x_post_state = 'posted'
        ORDER BY j.x_posted_at DESC, j.id
        LIMIT ?`,
    )
    .bind(limit)
    .all<{ id: string; title: string; company_name: string; x_post_url: string | null; x_posted_at: string | null }>();
  return results.map((r) => ({ id: r.id, title: r.title, companyName: r.company_name, url: r.x_post_url, postedAt: r.x_posted_at }));
}

const X_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com", "mobile.x.com"]);

/** Посилання на пост у X: https на x.com чи twitter.com зі шляхом /<акаунт>/status/<id>. */
export function xPostUrlOf(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || !X_HOSTS.has(u.hostname) || !/^\/[A-Za-z0-9_]{1,15}\/status\/\d{1,25}\/?$/.test(u.pathname)) return null;
  return `https://x.com${u.pathname.replace(/\/$/, "")}`;
}

/** "Mark as posted": пост уже в X, адмін вставляє посилання. Лише з черги. */
export async function markXPosted(db: D1Database, input: { jobId: string; adminUserId: string; url: string; now?: Date }): Promise<Result> {
  const url = xPostUrlOf(input.url);
  if (!url) return { ok: false, reason: "bad_url" };
  const at = sqlTime(input.now ?? new Date());
  return change(
    db,
    input,
    {
      sql: "UPDATE company_jobs SET x_post_state = 'posted', x_post_url = ?, x_posted_at = ? WHERE id = ? AND x_post_state = 'queued'",
      params: [url, at, input.jobId],
    },
    "x.posted",
    { url },
  );
}

/** "Skip": не постимо. Компанія бачить "X post: not posted"; повторно галочка його не ставить. */
export async function skipXPost(db: D1Database, input: { jobId: string; adminUserId: string; now?: Date }): Promise<Result> {
  return change(
    db,
    input,
    { sql: "UPDATE company_jobs SET x_post_state = 'skipped' WHERE id = ? AND x_post_state = 'queued'", params: [input.jobId] },
    "x.skipped",
  );
}
