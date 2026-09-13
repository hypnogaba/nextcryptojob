// Копіює договір API з docs/api/openapi.yaml у web/public/openapi.yaml.
// Запуск: node scripts/api-docs.mjs (також сам іде в prebuild).
//
// Сторінка /company/developers посилається на /openapi.yaml: репозиторій закритий,
// тож агентам договір віддає сам сайт (Workers static assets). Копію комітимо;
// тест src/lib/api/openapi-copy.test.ts падає, якщо копія розійшлась з docs/api.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SOURCE = fileURLToPath(new URL("../../docs/api/openapi.yaml", import.meta.url));
const TARGET = fileURLToPath(new URL("../public/openapi.yaml", import.meta.url));

if (!existsSync(SOURCE)) {
  console.log("api-docs: docs/api/openapi.yaml not found, keeping public/openapi.yaml as it is");
  process.exit(0);
}
const text = readFileSync(SOURCE, "utf8");
if (!existsSync(TARGET) || readFileSync(TARGET, "utf8") !== text) {
  writeFileSync(TARGET, text);
  console.log("api-docs: updated public/openapi.yaml");
}
