import type { CompanyInfo } from "@/lib/crm/context";
import { deliver, notifierFromEnv, type Notifier, type NotifyEnv, type OutgoingMessage } from "@/lib/crm/notify";
import { matchingIds, MATCH_IDS_MAX } from "@/lib/crm/search";
import { searchQuery } from "@/lib/crm/search-params";
import { SearchFilters, SORTS, type Sort } from "@/lib/crm/types";
import { escapeHtml } from "@/lib/telegram/send";
import { sqlTime } from "@/lib/time";

/**
 * Щоденні сповіщення збережених пошуків (специфікація CRM 5.7, cron щогодини).
 *
 * На черзі пошук з alert = 'daily', у компанії з доступом subscription (без
 * підписки сповіщення на паузі), чия остання перевірка (last_alert_at) була 24
 * год тому або ще не була. Для кожного:
 * - збіги = matchingIds (ті самі правила видимості й фільтри, що в пошуку, до 200,
 *   без квоти й без журналу);
 * - нові = збіги, чия видимість (consents.at згоди visibility) або бал
 *   (scores.computed_at ролі з фільтра; без ролі будь-якої) змінились після
 *   max(baseline_at, last_alert_at), і про кого цей пошук ще не сповіщав
 *   (seen_json): щотижневий перерахунок балу не повторює ту саму людину;
 * - спершу «беремо» пошук умовним UPDATE (last_alert_at = мить запуску,
 *   last_match_count = скільки нових, seen_json + нові, обрізано до 2 000
 *   найновіших), лише потім шлемо. Два запуски не шлють двох листів, а змінені
 *   за цей час фільтри (інший baseline_at) відкладають пошук до наступного запуску.
 *   Перевірка без нових теж ставить last_alert_at (last_match_count = 0): так
 *   пошук не перевіряється щогодини, а «нові» рахуються від останньої перевірки;
 * - є нові: повідомлення тому, хто створив пошук (якщо він досі в команді), інакше
 *   власникам, у їхній канал: "3 new candidates match "Solidity engineers"".
 *
 * Часового поясу компанії в базі немає: розклад за UTC, кожен пошук не частіше
 * разу на 24 год. `now` = запланована мить cron (рівно на початку години), тож
 * пошук, перевірений о 10:00, знову на черзі о 10:00 наступного дня, без зсуву.
 */

export const ALERT_BATCH = 25;
export const ALERT_INTERVAL_MS = 24 * 3_600_000;
export const SEEN_MAX = 2000;

export interface AlertOptions {
  env?: NotifyEnv;
  notifier?: Notifier;
  now?: Date;
  limit?: number;
}

export interface AlertResult {
  /** Пошуків перевірено (і позначено перевіреними). */
  checked: number;
  /** Скільки з них мали нових і отримали сповіщення. */
  alerted: number;
  /** Нових кандидатів разом. */
  newCandidates: number;
  /** Сповіщення не дійшло нікому. */
  notDelivered: number;
  /** Пошук змінився між читанням і записом: наступний запуск. */
  skipped: number;
  errors: number;
}

interface DueRow {
  id: string;
  company_id: string;
  name: string;
  filters_json: string;
  sort: string;
  seen_json: string;
  baseline_at: string | null;
  created_at: string;
  last_alert_at: string | null;
  created_by_user_id: string | null;
}

function parseSeen(json: string): string[] {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Текст сповіщення (5.7) і кнопка "Open search". */
export function alertMessage(o: { count: number; name: string; company: string; url: string }): OutgoingMessage {
  const name = o.name.replace(/\s+/g, " ").trim();
  const title = `${o.count} new ${o.count === 1 ? "candidate matches" : "candidates match"} "${name}"`;
  const line = `Saved search of ${o.company.replace(/\s+/g, " ").trim()} on NextCryptoJob.`;
  return {
    telegramHtml: `${escapeHtml(title)}\n${escapeHtml(line)}\n\n<a href="${escapeHtml(o.url)}">Open search</a>`,
    email: {
      subject: title,
      text: `${title}\n\n${line}\n\nOpen search: ${o.url}\n`,
      html:
        `<p>${escapeHtml(title)}</p><p>${escapeHtml(line)}</p>` +
        `<p><a href="${escapeHtml(o.url)}" style="display:inline-block;padding:10px 16px;border-radius:6px;` +
        `background:#0b6e63;color:#ffffff;text-decoration:none;font-weight:600">Open search</a></p>`,
    },
  };
}

type Person = { channel: "email" | "telegram"; telegram_id: string | null; email: string | null };

/** Той, хто створив пошук (якщо досі в команді), інакше власники. */
async function recipients(db: D1Database, companyId: string, creator: string | null): Promise<Person[]> {
  if (creator) {
    const { results } = await db
      .prepare(
        `SELECT u.channel, u.telegram_id, u.email FROM company_members m JOIN users u ON u.id = m.user_id
          WHERE m.company_id = ? AND m.user_id = ?`,
      )
      .bind(companyId, creator)
      .all<Person>();
    if (results.length) return results;
  }
  const { results } = await db
    .prepare(
      `SELECT u.channel, u.telegram_id, u.email FROM company_members m JOIN users u ON u.id = m.user_id
        WHERE m.company_id = ? AND m.role = 'owner' ORDER BY m.id`,
    )
    .bind(companyId)
    .all<Person>();
  return results;
}

/**
 * Кандидати зі списку, чия видимість або бал змінились після `since`.
 * Роль з фільтра: лише її бал; без ролі будь-який.
 */
async function changedSince(db: D1Database, ids: string[], since: string, role: string | null): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const { results } = await db
    .prepare(
      `SELECT j.value AS id FROM json_each(?1) j
        WHERE EXISTS (SELECT 1 FROM consents c
                       WHERE c.user_id = j.value AND c.kind = 'visibility' AND c.granted = 1 AND c.at > ?2)
           OR EXISTS (SELECT 1 FROM scores s
                       WHERE s.user_id = j.value AND (?3 IS NULL OR s.role = ?3) AND s.computed_at > ?2)`,
    )
    .bind(JSON.stringify(ids), since, role)
    .all<{ id: string }>();
  return new Set(results.map((r) => r.id));
}

export async function savedSearchAlerts(db: D1Database, opts: AlertOptions = {}): Promise<AlertResult> {
  const now = opts.now ?? new Date();
  const at = sqlTime(now);
  const notifier = opts.notifier ?? notifierFromEnv(opts.env ?? {});
  const out: AlertResult = { checked: 0, alerted: 0, newCandidates: 0, notDelivered: 0, skipped: 0, errors: 0 };

  const { results } = await db
    .prepare(
      `SELECT ss.id, ss.company_id, ss.name, ss.filters_json, ss.sort, ss.seen_json, ss.baseline_at, ss.created_at,
              ss.last_alert_at, ss.created_by_user_id
         FROM saved_searches ss JOIN company_access a ON a.company_id = ss.company_id
        WHERE ss.alert = 'daily' AND a.access = 'subscription'
          AND (ss.last_alert_at IS NULL OR ss.last_alert_at <= ?)
        ORDER BY ss.last_alert_at, ss.id
        LIMIT ?`,
    )
    .bind(sqlTime(new Date(now.getTime() - ALERT_INTERVAL_MS)), opts.limit ?? ALERT_BATCH)
    .all<DueRow>();

  const names = new Map<string, string>();
  for (const row of results) {
    try {
      const parsed = SearchFilters.safeParse(JSON.parse(row.filters_json));
      if (!parsed.success) throw new Error("saved search filters do not match SearchFilters");
      const filters = parsed.data;
      const sort: Sort = (SORTS as readonly string[]).includes(row.sort) ? (row.sort as Sort) : "score";

      const baseline = row.baseline_at ?? row.created_at;
      const since = row.last_alert_at && row.last_alert_at > baseline ? row.last_alert_at : baseline;
      const company = { id: row.company_id } as CompanyInfo;
      const ids = await matchingIds({ db, company, now }, filters, sort, MATCH_IDS_MAX);
      const changed = await changedSince(db, ids, since, filters.role ?? null);
      const seen = parseSeen(row.seen_json);
      const seenSet = new Set(seen);
      const fresh = ids.filter((id) => changed.has(id) && !seenSet.has(id));
      const nextSeen = [...seen, ...fresh].slice(-SEEN_MAX);

      const claim = await db
        .prepare(
          `UPDATE saved_searches SET last_alert_at = ?, last_match_count = ?, seen_json = ?
            WHERE id = ? AND alert = 'daily' AND last_alert_at IS ? AND baseline_at IS ?`,
        )
        .bind(at, fresh.length, JSON.stringify(nextSeen), row.id, row.last_alert_at, row.baseline_at)
        .run();
      if ((claim.meta.changes ?? 0) !== 1) {
        out.skipped++;
        continue;
      }
      out.checked++;
      if (fresh.length === 0) continue;

      out.alerted++;
      out.newCandidates += fresh.length;
      if (!names.has(row.company_id)) {
        const name = await db.prepare("SELECT name FROM companies WHERE id = ?").bind(row.company_id).first<string>("name");
        names.set(row.company_id, name ?? "your company");
      }
      const url = new URL(`/company/search?${searchQuery(filters, sort)}`, notifier.origin).toString();
      const message = alertMessage({ count: fresh.length, name: row.name, company: names.get(row.company_id)!, url });
      let sent = 0;
      for (const p of await recipients(db, row.company_id, row.created_by_user_id)) {
        const res = await deliver({ channel: p.channel, telegramId: p.telegram_id, email: p.email }, message, notifier);
        if (res.ok) sent++;
        else console.warn("alerts: not delivered", { savedSearchId: row.id, error: res.error });
      }
      if (sent === 0) out.notDelivered++;
    } catch (error) {
      out.errors++;
      console.error("alerts: saved search failed", { savedSearchId: row.id, error: error instanceof Error ? error.message : String(error) });
      // Зіпсований пошук не має стояти першим у черзі щогодини: наступна спроба через 24 год.
      try {
        await db
          .prepare("UPDATE saved_searches SET last_alert_at = ? WHERE id = ? AND last_alert_at IS ?")
          .bind(at, row.id, row.last_alert_at)
          .run();
      } catch {
        // База недоступна: спробуємо наступного запуску.
      }
    }
  }
  return out;
}
