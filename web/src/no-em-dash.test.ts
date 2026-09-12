import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Правило продукту: у текстах для людей немає довгого тире (U+2014).
// Перевіряємо весь src, бо текст інтерфейсу живе в компонентах, а не в одному файлі.
const EM_DASH = "\u2014";
const SRC = fileURLToPath(new URL(".", import.meta.url));

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(tsx?|css|mdx?)$/.test(name) ? [path] : [];
  });
}

describe("user-facing copy", () => {
  it("scans a non-empty set of source files", () => {
    expect(sourceFiles(SRC).length).toBeGreaterThan(0);
  });

  it("never contains an em dash", () => {
    const offenders = sourceFiles(SRC).flatMap((path) =>
      readFileSync(path, "utf8")
        .split("\n")
        .flatMap((line, i) =>
          line.includes(EM_DASH) ? [`${relative(SRC, path)}:${i + 1}`] : [],
        ),
    );
    expect(offenders).toEqual([]);
  });
});
