// Готує шрифти для картинки картки (next/og). Запуск: node scripts/card-fonts.mjs
//
// Satori читає лише TTF/OTF/WOFF і не бачить шрифтів next/font, а Worker не має
// файлової системи. Тому беремо з Google Fonts статичні TTF, урізані до потрібних
// символів, і кладемо їх у src/lib/card/fonts/*.ts як base64: так вони потрапляють
// у бандл Worker без жодних завантажувачів і без запиту назовні під час показу.
//
// Ліцензія: Unbounded і IBM Plex під SIL Open Font License 1.1, текст поруч у
// src/lib/card/fonts/OFL.txt. Файли не змінюємо, лише кладемо підмножину, яку
// віддає Google Fonts API.
//
// Набір символів Plex Sans мусить збігатися з DISPLAY_NAME_RANGES у
// src/lib/card/display-name.ts; тест fonts.test.ts перевіряє, що кожен дозволений
// символ імені справді є в шрифті.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../src/lib/card/fonts/", import.meta.url));

function range(from, to) {
  let s = "";
  for (let cp = from; cp <= to; cp++) s += String.fromCodePoint(cp);
  return s;
}

const ASCII = range(0x20, 0x7e);
// + «…»: Satori ставить його, коли ім'я не влазить у рядок.
const DISPLAY_NAME = ASCII + range(0xa0, 0x17f) + range(0x400, 0x45f) + range(0x490, 0x491) + "\u2026";

const FONTS = [
  { file: "unbounded-600", family: "Unbounded", weight: 600, text: "0123456789" },
  { file: "plex-sans-600", family: "IBM Plex Sans", weight: 600, text: DISPLAY_NAME },
  { file: "plex-mono-500", family: "IBM Plex Mono", weight: 500, text: ASCII },
];

for (const font of FONTS) {
  const css = await fetch(
    `https://fonts.googleapis.com/css2?family=${encodeURIComponent(font.family)}:wght@${font.weight}` +
      `&text=${encodeURIComponent(font.text)}`,
  ).then((r) => r.text());
  // Без браузерного User-Agent Google віддає саме truetype.
  const url = css.match(/src: url\((.+?)\) format\('truetype'\)/)?.[1];
  if (!url) throw new Error(`${font.family}: no truetype url in\n${css}`);
  const bytes = Buffer.from(await fetch(url).then((r) => r.arrayBuffer()));
  const body =
    `// Згенеровано scripts/card-fonts.mjs: ${font.family} ${font.weight}, підмножина TTF, SIL OFL 1.1 (див. OFL.txt).\n` +
    `// Не редагувати вручну.\n` +
    `const ttfBase64 = "${bytes.toString("base64")}";\n` +
    `export default ttfBase64;\n`;
  writeFileSync(`${OUT}${font.file}.ts`, body);
  console.log(`${font.file}: ${bytes.length} bytes TTF`);
}
