// Текст файлу як рядок: `import text from "./file.md?raw"` (Turbopack і Vitest вміють це самі).
declare module "*.md?raw" {
  const content: string;
  export default content;
}
