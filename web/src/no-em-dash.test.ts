import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Правило продукту: у текстах для людей немає довгого тире (U+2014), ні
// символом, ні HTML-сутністю. Перевіряємо весь web/: текст живе і в
// компонентах, і в метаданих, і в статичних файлах.
const PATTERNS = [/—/, /&mdash;/i, /&#8212;/, /&#x2014;/i];

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = fileURLToPath(import.meta.url);

// Залежності, артефакти збірки й згенеровані файли не наші тексти.
const SKIP_DIRS = new Set([
  "node_modules", ".next", ".open-next", ".wrangler", "out", "build", "coverage", ".git",
]);
const SKIP_FILES = new Set(["package-lock.json", "cloudflare-env.d.ts", "next-env.d.ts"]);
const TEXT_FILE = /\.(tsx?|mts|mjs|cjs|jsx?|css|jsonc?|html|txt|mdx?|svg)$|^_headers$/;

function textFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return SKIP_DIRS.has(name) ? [] : textFiles(path);
    if (path === SELF || SKIP_FILES.has(name)) return [];
    return TEXT_FILE.test(name) ? [path] : [];
  });
}

function offenders(files: string[]): string[] {
  return files.flatMap((path) =>
    readFileSync(path, "utf8")
      .split("\n")
      .flatMap((line, i) =>
        PATTERNS.some((p) => p.test(line)) ? [`${relative(ROOT, path)}:${i + 1}`] : [],
      ),
  );
}

describe("user-facing copy", () => {
  const files = textFiles(ROOT);

  it("scans the app, its config and static files", () => {
    const scanned = files.map((f) => relative(ROOT, f));
    expect(scanned).toEqual(
      expect.arrayContaining(["src/app/page.tsx", "package.json", "wrangler.jsonc"]),
    );
    expect(scanned.some((f) => f.startsWith("node_modules"))).toBe(false);
  });

  it("never contains an em dash, as a character or an HTML entity", () => {
    expect(offenders(files)).toEqual([]);
  });
});
