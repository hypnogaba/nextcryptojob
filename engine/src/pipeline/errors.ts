import { redact } from "../http.js";

/**
 * Коротко про помилку для `score_jobs.error`, `gap_reason` і журналу: один рядок,
 * адреси без значень ключів (http.ts redact), не довше `max` символів.
 */
export function shortError(e: unknown, max = 200): string {
  const name = e instanceof Error && e.name && e.name !== "Error" ? `${e.name}: ` : "";
  const raw = e instanceof Error ? e.message : String(e);
  const text = (name + raw)
    .replace(/https?:\/\/[^\s"'<>]+/g, (u) => redact(u))
    .replace(/\b(bearer|token|apikey|api_key|key)\b(\s*[:=]\s*|\s+)[^\s,;]+/gi, "$1$2***")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 3)}...` : text || "unknown error";
}

export const isAbortError = (e: unknown): boolean =>
  e instanceof Error && (e.name === "AbortError" || e.name === "TimeoutError");
