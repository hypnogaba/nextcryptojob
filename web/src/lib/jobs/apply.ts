import { hmacSha256Hex, sha256Hex } from "@/lib/auth/hash";
import type { CrmEnv } from "@/lib/crm/context";

/**
 * Хто рахується переходом "Apply" (/jobs/<id>/apply, специфікація 5.6). Відповідь для
 * всіх та сама (перехід на адресу компанії), рахується лише людина:
 * - не передвантаження браузера (Sec-Purpose: prefetch) і не відомий бот (User-Agent);
 * - у межах RL_PUBLIC для своєї IP (перевірка до запису в D1);
 * - раз на вакансію за 10 хвилин (ключ пари для apply_click_seen, 0018).
 */

/** Боти, прев'ю месенджерів і скрипти: вони ходять посиланнями, але не подаються на вакансії. */
const BOT_UA =
  /bot\b|bot\/|crawl|spider|slurp|preview|facebookexternalhit|embedly|whatsapp|headless|lighthouse|pingdom|uptime|monitor|curl\/|wget\/|python|go-http-client|java\/|okhttp|axios|node-fetch|undici|scrapy|httpclient|libwww/i;

/** Без User-Agent теж бот: браузер його завжди шле. */
export function isBot(userAgent: string | null): boolean {
  return !userAgent || BOT_UA.test(userAgent);
}

export function isPrefetch(headers: Headers): boolean {
  return /prefetch|prerender/i.test(`${headers.get("sec-purpose") ?? ""} ${headers.get("purpose") ?? ""}`);
}

/** Чи ця IP ще в межі RL_PUBLIC (той самий ліміт, що в search_jobs). Без прив'язки (розробка) межі немає. */
export async function underPublicLimit(env: Pick<CrmEnv, "RL_PUBLIC">, ip: string): Promise<boolean> {
  if (!env.RL_PUBLIC) return true;
  return (await env.RL_PUBLIC.limit({ key: `ip:${ip}` })).success;
}

/** Ключ пари (IP, вакансія): HMAC із SESSION_SECRET, щоб за ключем не можна було перебрати IP. */
export async function applyVisitorKey(env: Pick<CrmEnv, "SESSION_SECRET">, ip: string, jobId: string): Promise<string> {
  const message = `apply:${ip}:${jobId}`;
  const hex = env.SESSION_SECRET ? await hmacSha256Hex(env.SESSION_SECRET, message) : await sha256Hex(message);
  return hex.slice(0, 32);
}

/** Людина, яку варто рахувати (без запису): не передвантаження, не бот, у межі RL_PUBLIC. */
export async function countableVisit(request: Request, env: Pick<CrmEnv, "RL_PUBLIC">, ip: string): Promise<boolean> {
  if (isPrefetch(request.headers) || isBot(request.headers.get("user-agent"))) return false;
  return underPublicLimit(env, ip);
}
