// Власна точка входу Worker (специфікація CRM 3.6): fetch від OpenNext без змін
// і scheduled для cron-тригерів з wrangler.jsonc.
// Як радить OpenNext: https://opennext.js.org/cloudflare/howtos/custom-worker
// .open-next/worker.js з'являється лише після `npm run cf:build`, тому перед
// збіркою TypeScript його не бачить.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { default as handler } from "./.open-next/worker.js";
import { scheduledHandler, type CronEnv } from "./src/lib/cron";

const runScheduled = scheduledHandler();

export default {
  fetch: handler.fetch,
  // Чекаємо весь запуск тут (await), не в ctx.waitUntil: waitUntil у scheduled
  // обривається приблизно за 30 с після виходу з обробника (src/lib/cron/index.ts).
  async scheduled(controller, env) {
    await runScheduled(controller, env as unknown as CronEnv);
  },
} satisfies ExportedHandler<CloudflareEnv>;

// Durable Objects, які експортує точка входу OpenNext (у нас не прив'язані, але
// лишаємо експорт таким самим, як у згенерованому worker.js).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";
