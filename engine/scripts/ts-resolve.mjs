// Запуск TS-скриптів без збірки: імпорт "./x.js" веде на "./x.ts", якщо .js немає.
// Використання: node --experimental-transform-types --import ./scripts/ts-resolve.mjs scripts/<скрипт>.ts
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js") && context.parentURL?.startsWith("file:")) {
      const js = new URL(specifier, context.parentURL);
      const ts = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (!existsSync(js) && existsSync(ts)) return nextResolve(ts.href, context);
    }
    return nextResolve(specifier, context);
  },
});
