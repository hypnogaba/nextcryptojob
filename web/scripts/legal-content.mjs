// Копіює публічні юридичні чернетки з docs/legal у web/content/legal/*.ts.
// Запуск: node scripts/legal-content.mjs (також сам іде в prebuild).
//
// Сторінки /privacy, /terms, /terms/companies і /how-scoring-works рендерять ці
// тексти під час збірки. Модуль TS з рядком, а не .md: у Worker немає файлової
// системи, docs/ лежить поза web/, а Turbopack не імпортує .md як текст без
// завантажувача (як і шрифти картки, scripts/card-fonts.mjs). Копії комітимо;
// тест src/lib/legal/docs.test.tsx падає, якщо копія розійшлась з docs/legal.
//
// Єдина правка при копіюванні: довге тире (U+2014) стає комою, бо в текстах для
// людей його немає (правило продукту). Решту тексту не чіпаємо: це чернетки для юриста.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const DOCS = fileURLToPath(new URL("../../docs/legal/", import.meta.url));
const OUT = fileURLToPath(new URL("../content/legal/", import.meta.url));

const FILES = ["privacy-policy.md", "terms-candidates.md", "terms-companies.md", "how-scoring-works.md", "sources.md"];

if (!existsSync(DOCS)) {
  console.log("legal-content: docs/legal not found, keeping web/content/legal as it is");
  process.exit(0);
}

mkdirSync(OUT, { recursive: true });
for (const name of FILES) {
  const text = readFileSync(DOCS + name, "utf8").replace(/\s*\u2014\s*/g, ", ");
  const file = name.replace(/\.md$/, ".ts");
  const code =
    `// Згенеровано scripts/legal-content.mjs з docs/legal/${name}. Не правити руками.\n` +
    `const text: string = ${JSON.stringify(text)};\nexport default text;\n`;
  const target = OUT + file;
  if (existsSync(target) && readFileSync(target, "utf8") === code) continue;
  writeFileSync(target, code);
  console.log(`legal-content: updated content/legal/${file}`);
}
