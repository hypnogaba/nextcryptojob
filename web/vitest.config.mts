import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  // Той самий псевдонім, що в tsconfig, інакше тест не імпортує модуль з «@/…».
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // @cloudflare/workers-oauth-provider імпортує модуль середовища Workers, якого в Node немає.
      "cloudflare:workers": fileURLToPath(new URL("./src/test/stubs/cloudflare-workers.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    // Бібліотека OAuth іде через Vite (а не завантажувач Node), інакше псевдонім вище не діє.
    server: { deps: { inline: ["@cloudflare/workers-oauth-provider"] } },
  },
});
