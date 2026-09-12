import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// Статичні сторінки віддаються з Workers static assets, без KV чи R2.
// Цей кеш не вміє ревалідації (ISR): коли з'являться сторінки з revalidate,
// його треба замінити на R2/KV (див. документацію OpenNext про кеші).
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
});
