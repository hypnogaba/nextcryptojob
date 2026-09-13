// Власна точка входу Worker (специфікація CRM 3.6): fetch від OpenNext без змін
// і scheduled для cron-тригерів з wrangler.jsonc.
// Як радить OpenNext: https://opennext.js.org/cloudflare/howtos/custom-worker
// .open-next/worker.js з'являється лише після `npm run cf:build`, тому перед
// збіркою TypeScript його не бачить.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { default as handler } from "./.open-next/worker.js";
import { runCron, type CronEnv } from "./src/lib/cron";

export default {
  fetch: handler.fetch,
  async scheduled(controller, env, ctx) {
    // waitUntil: задачі можуть тривати довше за сам виклик scheduled.
    ctx.waitUntil(runCron(controller.cron, env as unknown as CronEnv, { scheduledTime: controller.scheduledTime }));
  },
} satisfies ExportedHandler<CloudflareEnv>;

// Durable Objects, які експортує точка входу OpenNext (у нас не прив'язані, але
// лишаємо експорт таким самим, як у згенерованому worker.js).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";
