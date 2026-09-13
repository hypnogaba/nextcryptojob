import { guardedAuditStatement, systemAuditActor } from "@/lib/crm/audit";
import { deliver, notifierFromEnv, type Notifier, type NotifyEnv, type OutgoingMessage } from "@/lib/crm/notify";
import { escapeHtml } from "@/lib/telegram/send";
import { sqlTime } from "@/lib/time";

/**
 * Прострочені вакансії компаній (специфікація CRM 5.6, cron щогодини). Відкрита вакансія
 * живе 60 днів (expires_at); з company_jobs_live (добірки, search_jobs, /jobs/<id>) вона
 * зникає сама в мить прострочення, а ця задача закриває її (status = 'closed', пост у X з
 * черги → 'skipped') і пише власникам компанії: "Your job "{title}" expired. Reopen it to keep
 * it in digests." Відкрити знову: "Publish again" (update_job зі status open, ще 60 днів).
 *
 * Кожна вакансія окремим пакетом: умовний UPDATE (досі відкрита й прострочена) і журнал
 * job.expire лише за справжнє закриття (changes() = 1). Лист лише після закриття, яке
 * зробила саме ця задача: повторний запуск, друга копія Worker чи компанія, що встигла
 * закрити сама, другого листа не дають (щонайбільше раз). Пачка до EXPIRE_JOBS_BATCH
 * найдавніше прострочених (індекс idx_company_jobs_open), і нової вакансії не беремо після
 * deadline; решту добере наступний запуск.
 */

export const EXPIRE_JOBS_BATCH = 200;

export interface CloseExpiredJobsOptions {
  /** Оточення Worker для сповіщень (TELEGRAM_BOT_TOKEN, EMAIL, SITE_URL). */
  env?: NotifyEnv;
  /** Готовий відправник (тести); інакше з env. */
  notifier?: Notifier;
  now?: Date;
  limit?: number;
  /** Після цієї миті (мс за `clock`) нових вакансій не беремо. */
  deadline?: number;
  clock?: () => Date;
}

export interface CloseExpiredJobsResult {
  closed: number;
  /** Власників, яким лист чи повідомлення дійшли. */
  notified: number;
  /** Власників, яким не дійшло нічого (немає каналу, бот заблоковано, пошта не налаштована). */
  notDelivered: number;
  /** Не взято: скінчився час запуску. */
  deferred: number;
  errors: number;
}

type DueRow = { id: string; company_id: string; title: string };
type Owner = { channel: "email" | "telegram"; telegram_id: string | null; email: string | null };

/** Повідомлення власнику (5.6) з посиланням на сторінку вакансії, де є "Publish again". */
export function jobExpiredMessage(o: { title: string; url: string }): OutgoingMessage {
  const title = o.title.replace(/\s+/g, " ").trim();
  const text = `Your job "${title}" expired. Reopen it to keep it in digests.`;
  return {
    telegramHtml: `${escapeHtml(text)}\n\n<a href="${escapeHtml(o.url)}">Open the job</a>`,
    email: {
      subject: `Your job "${title}" expired`,
      text: `${text}\n\nOpen the job: ${o.url}\n`,
      html: `<p>${escapeHtml(text)}</p><p><a href="${escapeHtml(o.url)}">Open the job</a></p>`,
    },
  };
}

async function owners(db: D1Database, companyId: string): Promise<Owner[]> {
  const { results } = await db
    .prepare(
      `SELECT u.channel, u.telegram_id, u.email FROM company_members m JOIN users u ON u.id = m.user_id
        WHERE m.company_id = ? AND m.role = 'owner' ORDER BY m.id`,
    )
    .bind(companyId)
    .all<Owner>();
  return results;
}

export async function closeExpiredJobs(db: D1Database, opts: CloseExpiredJobsOptions = {}): Promise<CloseExpiredJobsResult> {
  const now = opts.now ?? new Date();
  const at = sqlTime(now);
  const clock = opts.clock ?? (() => new Date());
  const notifier = opts.notifier ?? notifierFromEnv(opts.env ?? {});
  const out: CloseExpiredJobsResult = { closed: 0, notified: 0, notDelivered: 0, deferred: 0, errors: 0 };

  const { results: due } = await db
    .prepare(
      `SELECT id, company_id, title FROM company_jobs
        WHERE status = 'open' AND expires_at <= ?
        ORDER BY expires_at, id LIMIT ?`,
    )
    .bind(at, opts.limit ?? EXPIRE_JOBS_BATCH)
    .all<DueRow>();

  for (let i = 0; i < due.length; i++) {
    if (opts.deadline !== undefined && clock().getTime() >= opts.deadline) {
      out.deferred = due.length - i;
      break;
    }
    const job = due[i];
    try {
      // Журнал компанії з актором `<company_id>:system` (як прострочення знайомства).
      const meta = JSON.stringify({ company_id: job.company_id, job_id: job.id });
      const [closed] = await db.batch([
        db
          .prepare(
            `UPDATE company_jobs SET status = 'closed', closed_at = ?, updated_at = ?,
                    x_post_state = CASE x_post_state WHEN 'queued' THEN 'skipped' ELSE x_post_state END
              WHERE id = ? AND status = 'open' AND expires_at <= ?`,
          )
          .bind(at, at, job.id, at),
        guardedAuditStatement(db, [systemAuditActor(job.company_id), "job.expire", null, meta, at], { sql: "changes() = 1", params: [] }),
      ]);
      if ((closed.meta.changes ?? 0) !== 1) continue; // закрили раніше за нас: листа не шлемо
      out.closed++;
      const message = jobExpiredMessage({ title: job.title, url: `${notifier.origin}/company/jobs/${job.id}` });
      for (const owner of await owners(db, job.company_id)) {
        const sent = await deliver({ channel: owner.channel, telegramId: owner.telegram_id, email: owner.email }, message, notifier);
        if (sent.ok) out.notified++;
        else out.notDelivered++;
      }
    } catch (error) {
      out.errors++;
      console.error(`cron: job ${job.id} not expired: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return out;
}
