// Копіює публічні юридичні чернетки з docs/legal у web/content/legal.
// Запуск: node scripts/legal-content.mjs (також сам іде в prebuild).
//
// Сторінки /privacy, /terms, /terms/companies і /how-scoring-works імпортують ці
// копії як текст (`?raw`) і рендерять під час збірки: у Worker немає файлової
// системи, а docs/ лежить поза web/. Копії комітимо; тест src/lib/legal/docs.test.ts
// падає, якщо копія розійшлась з docs/legal.
//
// Єдина правка при копіюванні: довге тире (U+2014) стає комою, бо в текстах для
// людей його немає (правило продукту). Решту тексту не чіпаємо: це чернетки для юриста.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DOCS = fileURLToPath(new URL("../../docs/legal/", import.meta.url));
const OUT = fileURLToPath(new URL("../content/legal/", import.meta.url));

const FILES = ["privacy-policy.md", "terms-candidates.md", "terms-companies.md", "how-scoring-works.md"];

if (!existsSync(DOCS)) {
  console.log("legal-content: docs/legal not found, keeping web/content/legal as it is");
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
for (const name of FILES) {
  const text = readFileSync(DOCS + name, "utf8").replace(/\s*\u2014\s*/g, ", ");
  const target = OUT + name;
  if (existsSync(target) && readFileSync(target, "utf8") === text) continue;
  writeFileSync(target, text);
  console.log(`legal-content: updated content/legal/${name}`);
}
