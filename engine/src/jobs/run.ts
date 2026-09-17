// Перенесено з попереднього проєкту (сканер): runSource і mapLimit з src/http.ts.
import { SourceUnavailableError } from "../http.js";
import type { RawJob, SourceResult } from "./types.js";

/** Одне джерело: будь-який виняток стає результатом із причиною, а не падінням прогону. */
export async function runSource(source: string, fn: () => Promise<RawJob[]>): Promise<SourceResult> {
  try {
    return { source, ok: true, jobs: await fn() };
  } catch (e) {
    const rateLimited = e instanceof SourceUnavailableError && e.status === 429;
    return { source, ok: false, jobs: [], rateLimited, error: (e instanceof Error ? e.message : String(e)).slice(0, 300) };
  }
}

/** Не більше `limit` викликів одночасно; порядок результатів як у вході. */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  });
  await Promise.all(workers);
  return out;
}
