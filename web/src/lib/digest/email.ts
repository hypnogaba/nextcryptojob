import { z } from "zod";
import { hmacSha256Verify } from "@/lib/auth/hash";
import { cloudflareMailer } from "@/lib/mail/cloudflare";
import { digestEmail } from "@/lib/mail/digest";
import { siteOrigin } from "@/lib/site";
import { unsubscribeKey, unsubscribeUrl } from "./unsubscribe";

/**
 * POST /api/internal/digest-email: лист щоденної добірки від engine.
 * Контракт: engine/src/digest/README.md, розділ «Контракт ендпойнта листа».
 *
 * Порядок перевірок той, що в контракті: підпис над сирими байтами тіла до
 * розбору JSON, потім вік `ts`, потім ідемпотентність за `digest_id`.
 * Адресу engine не шле: беремо users.email (лише перевірена, договір §10).
 *
 * Коди, як їх читає engine (deliver.ts sendEmail): 2xx і 409 = доставлено,
 * 503 = `email not configured`, інші 4xx = failed без повтору, 5xx = один повтор.
 * - 200 лист пішов; 409 цей digest_id уже відправлено;
 * - 503 немає INTERNAL_API_SECRET чи EMAIL, або Email Service каже, що відправник не налаштований;
 * - 413 тіло більше за 64 КБ; 401 підпис чи `ts`; 400 конверт кривий або жодної доброї вакансії;
 * - 404 немає людини або її добірки; 422 немає пошти, або адресат чи лист не приймаються;
 * - 425 лист цієї добірки саме відправляє інший запит (не «доставлено»: engine запише failed);
 * - 502 тимчасова відмова Email Service: engine повторить, заявку можна забрати знову.
 */

export const SIGNATURE_HEADER = "NCJ-Internal-Signature";
/** Скільки секунд `ts` може відрізнятись від нашого годинника в будь-який бік. */
export const MAX_SKEW_SECONDS = 300;
/** П'ять вакансій це кілька кілобайт; більше тіло не читаємо далі. */
export const MAX_BODY_BYTES = 64 * 1024;
/**
 * Заявка 'sending', старша за це, вважається покинутою (ізолят упав посеред відправки):
 * її можна забрати знову. Молодшу не чіпаємо, лист ще може бути в дорозі.
 */
export const STALE_SENDING_MINUTES = 5;

const Maybe = (max: number) => z.string().max(max).nullable();

const Envelope = z.object({
  version: z.literal(1),
  digest_id: z.string().regex(/^dg_[A-Za-z0-9_-]{1,64}$/),
  user_id: z.string().min(1).max(64),
  local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ts: z.number().int(),
  /** Скільки живих вакансій переглянув підбір (з 14.09.2026); старий engine поля не шле. */
  pool_jobs: z.number().int().min(0).max(10_000_000).optional(),
  // Кожну вакансію перевіряємо окремо (Job нижче): крива вакансія не топить решту листа.
  jobs: z.array(z.unknown()).min(1).max(10),
});

const Job = z.object({
  position: z.number().int().min(1).max(50),
  title: z.string().trim().min(1).max(500),
  company: z.string().trim().min(1).max(300),
  location: Maybe(300),
  salary: Maybe(100),
  why: z.string().trim().min(1).max(1000),
  url: z.string().min(1).max(2048),
  posted_by: Maybe(300),
  source: z.enum(["nextrole", "company"]),
  /** Оцінка дошки підписом («est. … (web3.career estimate)»); старий engine поля не шле. */
  salary_estimate: Maybe(200).optional(),
  /** Одне-два речення про компанію (з 14.09.2026); старий engine поля не шле. */
  about: Maybe(400).optional(),
});

export type DigestEmailPayload = Omit<z.infer<typeof Envelope>, "jobs"> & { jobs: z.infer<typeof Job>[] };

export type DigestEmailDeps = {
  db: D1Database;
  env: { INTERNAL_API_SECRET?: string; SESSION_SECRET?: string; EMAIL?: SendEmail; SITE_URL?: string };
  /** Годинник для вікна `ts`; за замовчуванням зараз. */
  now?: () => Date;
};

const NO_STORE = { "Cache-Control": "no-store" };
const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: NO_STORE });

// ---------------- тіло ----------------

/**
 * Сирі байти тіла, не більше max. Content-Length більший за межу: відмова без читання;
 * без довжини (chunked) читаємо потік і обриваємо, щойно перейшли межу. null = завелике.
 */
async function readCapped(request: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) return null;
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

async function verified(request: Request, secret: string, raw: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(request.headers.get(SIGNATURE_HEADER)?.trim() ?? "");
  return m ? hmacSha256Verify(secret, raw, m[1]) : false;
}

/** Тіло за контрактом і скільки вакансій відкинуто; null, якщо конверт кривий або жодної доброї вакансії. */
function parse(raw: Uint8Array<ArrayBuffer>): { payload: DigestEmailPayload; dropped: number } | null {
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
  } catch {
    return null;
  }
  const envelope = Envelope.safeParse(json);
  if (!envelope.success) return null;
  const jobs = envelope.data.jobs.flatMap((j) => {
    const job = Job.safeParse(j);
    return job.success ? [job.data] : [];
  });
  if (jobs.length === 0) return null;
  return { payload: { ...envelope.data, jobs }, dropped: envelope.data.jobs.length - jobs.length };
}

// ---------------- помилки пошти ----------------

/** Код помилки Email Service (E_RATE_LIMIT_EXCEEDED тощо) без тексту: у тексті може бути адреса. */
function mailErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  return err instanceof Error ? err.name.slice(0, 64) : "unknown";
}

/**
 * Що робити з відмовою Email Service (коди: developers.cloudflare.com/email-service/api/send-emails/workers-api/).
 * - адресат або сам лист (у списку придушених, не дозволений, кривий заголовок чи вміст):
 *   повтор не допоможе, 422;
 * - відправник чи домен не налаштовані: 503, engine запише `email not configured`;
 * - решта (ліміти, збій сервісу, невідомий код): 502, engine повторить один раз.
 */
const RECIPIENT_OR_MESSAGE = new Set([
  "E_RECIPIENT_SUPPRESSED",
  "E_RECIPIENT_NOT_ALLOWED",
  "E_VALIDATION_ERROR",
  "E_FIELD_MISSING",
  "E_TOO_MANY_RECIPIENTS",
  "E_TOO_MANY_ATTACHMENTS",
  "E_CONTENT_TOO_LARGE",
]);
const NOT_CONFIGURED = new Set(["E_SENDER_NOT_VERIFIED", "E_SENDER_DOMAIN_NOT_AVAILABLE"]);

export function mailFailureStatus(code: string): 422 | 503 | 502 {
  if (RECIPIENT_OR_MESSAGE.has(code) || code.startsWith("E_HEADER")) return 422;
  if (NOT_CONFIGURED.has(code)) return 503;
  return 502;
}

// ---------------- заявка на лист ----------------

type Claim = "claimed" | "sent" | "sending";

/**
 * Одна інструкція: новий digest_id, упалий лист або покинута заявка стають нашими.
 * Решта: 'sent' (409, доставлено) або свіжа 'sending' (425, інший запит ще шле).
 */
async function claim(d: D1Database, digestId: string): Promise<Claim> {
  const res = await d
    .prepare(
      `INSERT INTO digest_emails (digest_id) VALUES (?1)
       ON CONFLICT (digest_id) DO UPDATE
          SET status = 'sending', attempts = attempts + 1, error = NULL, updated_at = datetime('now')
        WHERE digest_emails.status = 'failed'
           OR (digest_emails.status = 'sending' AND digest_emails.updated_at < datetime('now', ?2))`,
    )
    .bind(digestId, `-${STALE_SENDING_MINUTES} minutes`)
    .run();
  if (res.meta.changes === 1) return "claimed";
  const row = await d.prepare("SELECT status FROM digest_emails WHERE digest_id = ?").bind(digestId).first<{ status: string }>();
  return row?.status === "sent" ? "sent" : "sending";
}

async function markFailed(d: D1Database, digestId: string, code: string): Promise<void> {
  try {
    await d
      .prepare("UPDATE digest_emails SET status = 'failed', error = ?, updated_at = datetime('now') WHERE digest_id = ?")
      .bind(code, digestId)
      .run();
  } catch (e) {
    // Рядок лишається 'sending': повтор отримає 425, а через 5 хвилин заявку можна забрати.
    console.warn(`digest-email: ${digestId} failed status not saved (${e instanceof Error ? e.message.slice(0, 200) : "unknown"})`);
  }
}

// ---------------- обробник ----------------

export async function digestEmailResponse(request: Request, deps: DigestEmailDeps): Promise<Response> {
  const secret = deps.env.INTERNAL_API_SECRET;
  if (!secret) return reply(503, { error: "internal API not configured" });

  const raw = await readCapped(request, MAX_BODY_BYTES);
  if (!raw) return reply(413, { error: "body too large" });
  if (!(await verified(request, secret, raw))) return reply(401, { error: "bad signature" });

  const parsed = parse(raw);
  if (!parsed) return reply(400, { error: "body does not match the contract" });
  const { payload: body, dropped } = parsed;
  const nowSeconds = Math.floor((deps.now ?? (() => new Date()))().getTime() / 1000);
  if (Math.abs(nowSeconds - body.ts) > MAX_SKEW_SECONDS) return reply(401, { error: "stale ts" });

  const binding = deps.env.EMAIL;
  if (!binding) return reply(503, { error: "email not configured" });

  // Людина і її добірка одним запитом: digest_id мусить належати саме цій людині.
  const row = await deps.db
    .prepare(
      `SELECT u.email, r.id AS run_id
         FROM users u LEFT JOIN digest_runs r ON r.id = ?2 AND r.user_id = u.id
        WHERE u.id = ?1`,
    )
    .bind(body.user_id, body.digest_id)
    .first<{ email: string | null; run_id: string | null }>();
  if (!row) return reply(404, { error: "user not found" });
  if (!row.email) return reply(422, { error: "user has no email" });
  if (!row.run_id) return reply(404, { error: "digest not found for this user" });

  // Лист складаємо до заявки: помилка тут не лишає заявку 'sending'.
  const site = siteOrigin(deps.env);
  const message = digestEmail({
    localDate: body.local_date,
    jobs: body.jobs,
    checked: body.pool_jobs ?? null,
    site,
    unsubscribeUrl: await unsubscribeUrl(site, unsubscribeKey(deps.env) ?? secret, body.user_id),
  });

  const claimed = await claim(deps.db, body.digest_id);
  if (claimed === "sent") return reply(409, { error: "digest email already sent" });
  if (claimed === "sending") return reply(425, { error: "digest email is being sent by another request" });

  try {
    await cloudflareMailer(binding).send({ to: row.email, ...message });
  } catch (err) {
    const code = mailErrorCode(err);
    const status = mailFailureStatus(code);
    console.warn(`digest-email: ${body.digest_id} not sent (${code}, HTTP ${status})`);
    await markFailed(deps.db, body.digest_id, code);
    return reply(status, { error: status === 503 ? "email not configured" : "email service refused", code });
  }

  try {
    await deps.db
      .prepare("UPDATE digest_emails SET status = 'sent', updated_at = datetime('now') WHERE digest_id = ?")
      .bind(body.digest_id)
      .run();
  } catch (e) {
    // Лист уже пішов. Рядок лишається 'sending': повтор у ці 5 хвилин отримає 425, не другий лист.
    console.warn(`digest-email: ${body.digest_id} sent, status not saved (${e instanceof Error ? e.message.slice(0, 200) : "unknown"})`);
  }
  if (dropped > 0) console.warn(`digest-email: ${body.digest_id} sent without ${dropped} invalid job(s)`);
  return reply(200, { ok: true, digest_id: body.digest_id, jobs: body.jobs.length, dropped });
}
