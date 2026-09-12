import { z } from "zod";
import { hmacSha256Verify } from "@/lib/auth/hash";
import { cloudflareMailer } from "@/lib/mail/cloudflare";
import { digestEmail } from "@/lib/mail/digest";

/**
 * POST /api/internal/digest-email: лист щоденної добірки від engine.
 * Контракт: engine/src/digest/README.md, розділ «Контракт ендпойнта листа».
 *
 * Порядок перевірок той, що в контракті: підпис над сирими байтами тіла до
 * розбору JSON, потім вік `ts`, потім ідемпотентність за `digest_id`.
 * Адресу engine не шле: беремо users.email (лише перевірена, договір §10).
 *
 * Коди, як їх читає engine (deliver.ts sendEmail):
 * - 200 лист пішов; 409 цей digest_id уже відправлено або він у дорозі;
 * - 503 немає INTERNAL_API_SECRET чи EMAIL (engine пише `email not configured`);
 * - 400 тіло не за контрактом, 401 підпис чи `ts`, 404 немає людини або її
 *   добірки, 422 у людини немає пошти: engine пише failed і не повторює;
 * - 502 поштовий сервіс відмовив: engine повторить один раз, рядок digest_emails
 *   тоді можна забрати знову.
 */

export const SIGNATURE_HEADER = "NCJ-Internal-Signature";
/** Скільки секунд `ts` може відрізнятись від нашого годинника в будь-який бік. */
export const MAX_SKEW_SECONDS = 300;
/** П'ять вакансій це кілька кілобайт; більше тіло не читаємо далі. */
export const MAX_BODY_BYTES = 64 * 1024;

const Text = (max: number) => z.string().min(1).max(max);
const Maybe = (max: number) => z.string().max(max).nullable();

const Payload = z.object({
  version: z.literal(1),
  digest_id: z.string().regex(/^dg_[A-Za-z0-9_-]{1,64}$/),
  user_id: Text(64),
  local_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  ts: z.number().int(),
  jobs: z
    .array(
      z.object({
        position: z.number().int().min(1).max(50),
        title: Text(500),
        company: Text(300),
        location: Maybe(300),
        salary: Maybe(100),
        why: Text(1000),
        url: Text(2048),
        posted_by: Maybe(300),
        source: z.enum(["nextrole", "company"]),
      }),
    )
    .min(1)
    .max(10),
});

export type DigestEmailPayload = z.infer<typeof Payload>;

export type DigestEmailDeps = {
  db: D1Database;
  env: { INTERNAL_API_SECRET?: string; EMAIL?: SendEmail };
  /** Годинник для вікна `ts`; за замовчуванням зараз. */
  now?: () => Date;
};

const NO_STORE = { "Cache-Control": "no-store" };
const reply = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: NO_STORE });

/** Код помилки Email Service (E_RATE_LIMIT_EXCEEDED тощо) без тексту: у тексті може бути адреса. */
function mailErrorCode(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code)) return code;
  return err instanceof Error ? err.name.slice(0, 64) : "unknown";
}

async function verified(request: Request, secret: string, raw: Uint8Array<ArrayBuffer>): Promise<boolean> {
  const m = /^sha256=([0-9a-f]{64})$/i.exec(request.headers.get(SIGNATURE_HEADER)?.trim() ?? "");
  return m ? hmacSha256Verify(secret, raw, m[1]) : false;
}

function parse(raw: Uint8Array<ArrayBuffer>): DigestEmailPayload | null {
  try {
    const parsed = Payload.safeParse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export async function digestEmailResponse(request: Request, deps: DigestEmailDeps): Promise<Response> {
  const secret = deps.env.INTERNAL_API_SECRET;
  if (!secret) return reply(503, { error: "internal API not configured" });

  const raw = new Uint8Array(await request.arrayBuffer());
  if (raw.byteLength > MAX_BODY_BYTES) return reply(413, { error: "body too large" });
  if (!(await verified(request, secret, raw))) return reply(401, { error: "bad signature" });

  const body = parse(raw);
  if (!body) return reply(400, { error: "body does not match the contract" });
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

  // Заявка на лист. Новий digest_id або той, чий лист упав: наш. Решта (sent, sending): 409.
  const claim = await deps.db
    .prepare(
      `INSERT INTO digest_emails (digest_id) VALUES (?)
       ON CONFLICT (digest_id) DO UPDATE
          SET status = 'sending', attempts = attempts + 1, error = NULL, updated_at = datetime('now')
        WHERE digest_emails.status = 'failed'`,
    )
    .bind(body.digest_id)
    .run();
  if (claim.meta.changes !== 1) return reply(409, { error: "digest email already sent" });

  const message = digestEmail({ localDate: body.local_date, jobs: body.jobs, origin: new URL(request.url).origin });
  try {
    await cloudflareMailer(binding).send({ to: row.email, ...message });
  } catch (err) {
    const code = mailErrorCode(err);
    console.warn(`digest-email: ${body.digest_id} not sent (${code})`);
    await deps.db
      .prepare("UPDATE digest_emails SET status = 'failed', error = ?, updated_at = datetime('now') WHERE digest_id = ?")
      .bind(code, body.digest_id)
      .run()
      .catch(() => undefined);
    return reply(502, { error: "email service failed", code });
  }

  try {
    await deps.db
      .prepare("UPDATE digest_emails SET status = 'sent', updated_at = datetime('now') WHERE digest_id = ?")
      .bind(body.digest_id)
      .run();
  } catch {
    // Лист уже пішов. Рядок лишається 'sending', і повтор все одно отримає 409.
    console.warn(`digest-email: ${body.digest_id} sent, status not saved`);
  }
  return reply(200, { ok: true, digest_id: body.digest_id });
}
