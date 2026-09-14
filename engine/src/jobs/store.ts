// Сховище сканера: база вакансій NextCryptoJob (D1 `nextcryptojob-jobs`, db/jobs) або, насухо,
// лише лічильник записів. Сканер знає тільки цей інтерфейс, тож сухий прогін іде тим самим кодом.
import type { D1Meta, D1Statement, StatementOptions } from "../d1.js";
import { type SeedRegistry, seedBoards, seedCompanies, seedGetro } from "./seed.js";
import { type AtsProvider, type BoardSource, type Company, type GetroCollection, isAtsProvider, type JobRow,
  type SourceKind, type SourceState } from "./types.js";

/** Що сховище бере від клієнта D1: D1Client у продукті, SQLite у тестах (без meta). */
export interface JobsBackend {
  query<T>(sql: string, params?: unknown[], opts?: StatementOptions): Promise<T[]>;
  batch(statements: D1Statement[], opts?: StatementOptions): Promise<void>;
  batchWithMeta?(statements: D1Statement[], opts?: StatementOptions): Promise<{ rowsWritten: number | null }>;
  queryWithMeta?<T>(sql: string, params?: unknown[], opts?: StatementOptions): Promise<{ results: T[]; meta: D1Meta }>;
}

export interface Registry {
  companies: Company[];
  boards: BoardSource[];
  states: SourceState[];
  getro: GetroCollection[];
}

/** Зміна стану джерела: збій (новий день) або одужання. Здорове джерело рядка не має. */
export type SourceChange =
  | { source: string; kind: "fail"; status: "failing" | "dead"; failDays: number; error: string; at: string }
  | { source: string; kind: "retry"; at: string }
  | { source: string; kind: "recover" };

export interface RunFinish {
  status: "ok" | "partial" | "failed";
  sourcesOk: number;
  sourcesFailed: number;
  jobsFound: number;
  jobsNew: number;
  rowsWritten: number | null;
  notes: unknown;
}

export interface NewCompany { slug: string; name: string; provider: AtsProvider; atsSlug: string; discoveredVia: string; note: string | null }

/**
 * Скільки рядків D1 коштує одна інструкція (запис у таблицю й у кожен індекс зі зміненим
 * стовпцем), для сухого прогону. jobs_cache WITHOUT ROWID без вторинних індексів: 1 на рядок і
 * для нового, і для оновлення. scan_runs: вставка в таблицю й idx_scan_runs_kind_started (2),
 * завершення лише таблиця (1). companies: таблиця й UNIQUE(ats_provider, ats_slug) (2).
 * Живий прогін бере справжнє число з meta.rows_written.
 */
export const WRITE_COST = { job: 1, runStart: 2, runFinish: 1, sourceState: 1, company: 2 } as const;

/** Рядків в одній інструкції вставки вакансій: 20 стовпців × 5 = 100 параметрів (D1 дозволяє 100). */
export const JOBS_PER_STATEMENT = 5;

const JOB_COLUMNS = "id, url, company, company_key, title, location, remote, salary_min, salary_max, salary_currency, " +
  "source, tags, dedupe_key, posted_at, fetched_at, first_seen_at, country, salary_est_min, salary_est_max, salary_est_currency";
export const JOB_PARAMS = 20;

/**
 * Upsert вакансій. first_seen_at лише при вставці. Вилка: нова, якщо джерело її дало, інакше стара
 * (джерело могло цього разу не віддати текст); три поля разом, щоб не змішати мінімум з однієї
 * вилки з валютою іншої. Дату публікації теж не стираємо порожньою. Оцінка дошки (salary_est_*)
 * так само окремою трійкою; вилки роботодавця вона не чіпає.
 */
export function upsertJobsSql(n: number): string {
  const row = `(${Array.from({ length: JOB_PARAMS }, () => "?").join(", ")})`;
  const keep = "excluded.salary_min IS NULL AND excluded.salary_max IS NULL";
  const keepEst = "excluded.salary_est_min IS NULL AND excluded.salary_est_max IS NULL";
  return `INSERT INTO jobs_cache (${JOB_COLUMNS})
VALUES ${Array.from({ length: n }, () => row).join(", ")}
ON CONFLICT(id) DO UPDATE SET
  url = excluded.url, company = excluded.company, company_key = excluded.company_key, title = excluded.title,
  location = excluded.location, remote = excluded.remote, source = excluded.source, tags = excluded.tags,
  dedupe_key = excluded.dedupe_key, fetched_at = excluded.fetched_at, country = excluded.country,
  posted_at = COALESCE(excluded.posted_at, jobs_cache.posted_at),
  salary_min = CASE WHEN ${keep} THEN jobs_cache.salary_min ELSE excluded.salary_min END,
  salary_max = CASE WHEN ${keep} THEN jobs_cache.salary_max ELSE excluded.salary_max END,
  salary_currency = CASE WHEN ${keep} THEN jobs_cache.salary_currency ELSE excluded.salary_currency END,
  salary_est_min = CASE WHEN ${keepEst} THEN jobs_cache.salary_est_min ELSE excluded.salary_est_min END,
  salary_est_max = CASE WHEN ${keepEst} THEN jobs_cache.salary_est_max ELSE excluded.salary_est_max END,
  salary_est_currency = CASE WHEN ${keepEst} THEN jobs_cache.salary_est_currency ELSE excluded.salary_est_currency END`;
}

const jobParams = (j: JobRow): unknown[] => [
  j.id, j.url, j.company, j.companyKey, j.title, j.location, j.remote ? 1 : 0, j.salaryMin, j.salaryMax, j.salaryCurrency,
  j.source, JSON.stringify(j.tags), j.dedupeKey, j.postedAt, j.fetchedAt, j.fetchedAt, null,
  j.salaryEstMin, j.salaryEstMax, j.salaryEstCurrency,
];

const SOURCE_KINDS: readonly SourceKind[] = ["jsonld", "nextjs", "rss", "speedrun"];

/**
 * Сховище. `dry`: жодного запису, лише лічильник WRITE_COST; реєстр і наявні id читаються з
 * бази (лише SELECT), а без бази реєстр береться з засіву (seed.ts).
 */
export class JobsStore {
  /** Оцінка записів за WRITE_COST (насухо) і справжнє число з meta (живий прогін, якщо D1 його дав). */
  estimatedRows = 0;
  measuredRows: number | null = 0;

  constructor(private readonly backend: JobsBackend | null, readonly dry: boolean, private readonly seed: SeedRegistry | null = null) {
    if (!backend && !dry) throw new Error("jobs store: без бази можна лише насухо (--dry)");
    if (!backend && !seed) throw new Error("jobs store: без бази потрібен засів реєстру");
  }

  get hasDatabase(): boolean { return this.backend !== null; }

  private note(rows: number, measured: number | null | undefined): void {
    this.estimatedRows += rows;
    if (this.dry) return;
    this.measuredRows = this.measuredRows !== null && typeof measured === "number" ? this.measuredRows + measured : null;
  }

  private async write(statements: D1Statement[], estimate: number): Promise<void> {
    if (statements.length === 0) return;
    if (this.dry || !this.backend) { this.note(estimate, null); return; }
    if (this.backend.batchWithMeta) {
      const { rowsWritten } = await this.backend.batchWithMeta(statements, { idempotent: true });
      this.note(estimate, rowsWritten);
    } else {
      await this.backend.batch(statements, { idempotent: true });
      this.note(estimate, estimate);
    }
  }

  async loadRegistry(): Promise<Registry> {
    if (!this.backend) {
      return { companies: seedCompanies(this.seed!), boards: seedBoards(this.seed!), states: [], getro: seedGetro(this.seed!) };
    }
    const [companies, boards, states, getro] = await Promise.all([
      this.backend.query<{ slug: string; name: string; ats_provider: string; ats_slug: string }>(
        "SELECT slug, name, ats_provider, ats_slug FROM companies WHERE enabled = 1 ORDER BY slug"),
      this.backend.query<{ name: string; label: string; kind: string; feed_url: string; crypto_only: number }>(
        "SELECT name, label, kind, feed_url, crypto_only FROM sources WHERE enabled = 1 ORDER BY name"),
      this.backend.query<{ source: string; status: string; fail_days: number; last_error: string | null; failed_at: string; checked_at: string }>(
        "SELECT source, status, fail_days, last_error, failed_at, checked_at FROM source_state"),
      this.backend.query<{ collection_id: number; label: string }>(
        "SELECT collection_id, label FROM getro_collections WHERE enabled = 1 ORDER BY collection_id"),
    ]);
    return {
      companies: companies.filter((c) => isAtsProvider(c.ats_provider))
        .map((c) => ({ slug: c.slug, name: c.name, provider: c.ats_provider as AtsProvider, atsSlug: c.ats_slug })),
      boards: boards.filter((b) => SOURCE_KINDS.includes(b.kind as SourceKind))
        .map((b) => ({ name: b.name, label: b.label, kind: b.kind as SourceKind, feedUrl: b.feed_url, cryptoOnly: b.crypto_only === 1 })),
      states: states.map((s) => ({ source: s.source, status: s.status === "dead" ? "dead" : "failing", failDays: Number(s.fail_days) || 1,
        lastError: s.last_error, failedAt: s.failed_at, checkedAt: s.checked_at })),
      getro: getro.map((g) => ({ id: Number(g.collection_id), label: g.label })),
    };
  }

  /** Усі id у базі (для «скільки нових»). Без бази порожньо: насухо все рахується новим. */
  async existingIds(): Promise<Set<string>> {
    if (!this.backend) return new Set();
    return new Set((await this.backend.query<{ id: string }>("SELECT id FROM jobs_cache")).map((r) => r.id));
  }

  async startRun(id: string, kind: "scan" | "discover" | "prune", at: string): Promise<void> {
    await this.write([{ sql: "INSERT INTO scan_runs (id, kind, started_at) VALUES (?, ?, ?)", params: [id, kind, at] }], WRITE_COST.runStart);
  }

  async finishRun(id: string, f: RunFinish, at: string): Promise<void> {
    await this.write([{
      sql: `UPDATE scan_runs SET finished_at = ?, status = ?, sources_ok = ?, sources_failed = ?, jobs_found = ?, jobs_new = ?,
              rows_written = ?, notes = ? WHERE id = ?`,
      params: [at, f.status, f.sourcesOk, f.sourcesFailed, f.jobsFound, f.jobsNew, f.rowsWritten,
        JSON.stringify(f.notes).slice(0, 20_000), id],
    }], WRITE_COST.runFinish);
  }

  async upsertJobs(rows: readonly JobRow[]): Promise<void> {
    const statements: D1Statement[] = [];
    for (let i = 0; i < rows.length; i += JOBS_PER_STATEMENT) {
      const part = rows.slice(i, i + JOBS_PER_STATEMENT);
      statements.push({ sql: upsertJobsSql(part.length), params: part.flatMap(jobParams) });
    }
    await this.write(statements, rows.length * WRITE_COST.job);
  }

  async applySourceChanges(changes: readonly SourceChange[]): Promise<void> {
    const statements: D1Statement[] = changes.map((c) => {
      if (c.kind === "recover") return { sql: "DELETE FROM source_state WHERE source = ?", params: [c.source] };
      if (c.kind === "retry") return { sql: "UPDATE source_state SET checked_at = ? WHERE source = ?", params: [c.at, c.source] };
      return {
        sql: `INSERT INTO source_state (source, status, fail_days, last_error, failed_at, checked_at) VALUES (?, ?, ?, ?, ?, ?)
              ON CONFLICT(source) DO UPDATE SET status = excluded.status, fail_days = excluded.fail_days,
                last_error = excluded.last_error, failed_at = excluded.failed_at, checked_at = excluded.checked_at`,
        params: [c.source, c.status, c.failDays, c.error.slice(0, 300), c.at, c.at],
      };
    });
    await this.write(statements, statements.length * WRITE_COST.sourceState);
  }

  /** Нові компанії з розвідки. Наявний рядок (за slug чи за дошкою) не чіпається. */
  async addCompanies(cs: readonly NewCompany[]): Promise<void> {
    await this.write(cs.map((c) => ({
      sql: `INSERT INTO companies (slug, name, ats_provider, ats_slug, discovered_via, note) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT DO NOTHING`,
      params: [c.slug, c.name, c.provider, c.atsSlug, c.discoveredVia, c.note],
    })), cs.length * WRITE_COST.company);
  }

  /** Дошки ATS, що вже є в реєстрі, увімкнені чи ні: розвідка не має їх додавати вдруге. */
  async knownBoards(): Promise<Set<string>> {
    if (!this.backend) return new Set(this.seed!.companies.map((c) => `${c.ats_provider}:${c.ats_slug.toLowerCase()}`));
    const rows = await this.backend.query<{ ats_provider: string; ats_slug: string }>("SELECT ats_provider, ats_slug FROM companies");
    return new Set(rows.map((r) => `${r.ats_provider}:${r.ats_slug.toLowerCase()}`));
  }

  async knownSlugs(): Promise<Set<string>> {
    if (!this.backend) return new Set(this.seed!.companies.map((c) => c.slug));
    return new Set((await this.backend.query<{ slug: string }>("SELECT slug FROM companies")).map((r) => r.slug));
  }

  /** Скільки вакансій скан не бачив з `before` (ISO). */
  async countStale(before: string): Promise<number> {
    if (!this.backend) return 0;
    const [r] = await this.backend.query<{ n: number }>("SELECT COUNT(*) AS n FROM jobs_cache WHERE fetched_at < ?", [before]);
    return Number(r?.n) || 0;
  }

  /** Прибрати вакансії, яких скан не бачив з `before`, і прогони, старші за `runsBefore`. */
  async prune(before: string, runsBefore: string): Promise<{ jobs: number; runs: number }> {
    if (!this.backend) return { jobs: 0, runs: 0 };
    const jobs = await this.countStale(before);
    const [r] = await this.backend.query<{ n: number }>("SELECT COUNT(*) AS n FROM scan_runs WHERE started_at < ?", [runsBefore]);
    const runs = Number(r?.n) || 0;
    // Один DELETE за умовою: індексу на fetched_at немає, тож це прохід по таблиці раз на тиждень
    // (читання копійчані), а записів рівно стільки, скільки рядків прибрано.
    await this.write([
      { sql: "DELETE FROM jobs_cache WHERE fetched_at < ?", params: [before] },
      { sql: "DELETE FROM scan_runs WHERE started_at < ?", params: [runsBefore] },
    ], jobs * WRITE_COST.job + runs * (WRITE_COST.runStart));
    return { jobs, runs };
  }
}
