// Прибирання бази вакансій (`jobs-prune [--dry] [--days N]`), раз на тиждень.
//
// Вакансія, якої скан не бачив N днів (типово 30), уже знята з дошки: у пул вона не потрапляє з
// третього дня (LIVE_WINDOW_DAYS), а зберігати її коштує читань кожного проходу пулу. Видаляти
// безпечно: id виводиться з адреси (ids.ts), тож якщо вакансія повернеться, вона повернеться з тим
// самим id, і `sent.job_ref` не дасть надіслати її людині вдруге. Історія добірок на сайті покаже
// таку вакансію як «gone», як і будь-яку зняту.
import { randomUUID } from "node:crypto";
import { LIVE_WINDOW_DAYS } from "../digest/jobs.js";
import type { EngineEnv } from "../pipeline/registry.js";
import { envInt } from "./env.js";
import type { JobsStore } from "./store.js";

export const PRUNE_DAYS = 30;
/** Журнал прогонів тримаємо пів року. */
export const RUNS_KEEP_DAYS = 180;
const DAY_MS = 86_400_000;

export interface PruneDeps {
  store: JobsStore;
  env: EngineEnv;
  days?: number;
  now?: Date;
  log?: (line: string) => void;
}

export async function runJobsPrune(deps: PruneDeps): Promise<{ jobs: number; runs: number; days: number }> {
  const { store } = deps;
  const now = deps.now ?? new Date();
  const log = deps.log ?? ((l: string) => console.log(l));
  // Менше за живе вікно не можна: прибрали б вакансії, які ще в пулі.
  const days = deps.days ?? envInt(deps.env, "JOBS_PRUNE_DAYS", PRUNE_DAYS, LIVE_WINDOW_DAYS + 1, 3650);
  if (days <= LIVE_WINDOW_DAYS) throw new Error(`--days має бути більше за ${LIVE_WINDOW_DAYS} (живе вікно пулу)`);
  const before = new Date(now.getTime() - days * DAY_MS).toISOString();
  const runsBefore = new Date(now.getTime() - RUNS_KEEP_DAYS * DAY_MS).toISOString();
  const runId = `prune_${randomUUID()}`;
  await store.startRun(runId, "prune", now.toISOString());
  const r = await store.prune(before, runsBefore);
  await store.finishRun(runId, { status: "ok", sourcesOk: 0, sourcesFailed: 0, jobsFound: r.jobs, jobsNew: 0,
    rowsWritten: store.dry ? null : store.measuredRows, notes: { days, jobs: r.jobs, runs: r.runs } }, new Date().toISOString());
  log(`jobs-prune${store.dry ? " --dry" : ""}: ${r.jobs} jobs not seen for ${days} d, ${r.runs} runs older than ${RUNS_KEEP_DAYS} d` +
      `${store.dry ? " (nothing deleted)" : " deleted"}; D1 rows ${store.dry ? `would be ${store.estimatedRows}` : `written ${store.measuredRows ?? "unknown"}`}`);
  return { ...r, days };
}
