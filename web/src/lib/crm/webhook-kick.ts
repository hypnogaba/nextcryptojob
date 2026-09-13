import { getCloudflareContext } from "@opennextjs/cloudflare";
import { notifierFromEnv, type NotifyEnv } from "./notify";
import { deliverIntroWebhook } from "./webhooks";

/**
 * Перша спроба вебхука одразу після відповіді кандидата (специфікація 7.6:
 * «одразу після зміни стану, у ctx.waitUntil, таймаут 10 с»). Лише в запиті
 * Worker, де є waitUntil; інакше (тести, розробка без Worker) нічого не робить,
 * і подію добере cron за 5 хв. Спроба та сама, що в cron (deliverIntroWebhook
 * бере рядок умовним UPDATE), тож разом вони не шлють двічі.
 */
export function deliverWebhookSoon(introId: string): void {
  try {
    const { env, ctx } = getCloudflareContext();
    const workerEnv = env as unknown as NotifyEnv & { DB?: D1Database; WEBHOOK_SIGNING_KEY?: string };
    const signingKey = workerEnv.WEBHOOK_SIGNING_KEY?.trim();
    if (!workerEnv.DB || !signingKey || typeof ctx?.waitUntil !== "function") return;
    const task = deliverIntroWebhook(workerEnv.DB, introId, {
      signingKey,
      env: workerEnv,
      notifier: notifierFromEnv(workerEnv),
    }).catch((error: unknown) => {
      console.error("webhooks: immediate delivery failed", { introId, error: error instanceof Error ? error.message : String(error) });
    });
    ctx.waitUntil(task);
  } catch {
    // Поза запитом Worker: доставить cron.
  }
}
