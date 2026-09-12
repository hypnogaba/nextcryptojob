// Лише для тестів: підставна база вакансій NextRole. Справжній SQLite зі схемою jobs_cache
// як у живій базі crypto-jobs-agent (12.09), тож запити добірки виконуються насправді.
import { SqliteD1 } from "./sqlite-d1.js";

const JOBS_CACHE = `CREATE TABLE jobs_cache (
    id TEXT PRIMARY KEY, url TEXT NOT NULL UNIQUE, company TEXT NOT NULL, company_key TEXT NOT NULL,
    title TEXT NOT NULL, location TEXT, remote INTEGER NOT NULL DEFAULT 0, salary_min INTEGER, salary_max INTEGER,
    salary_currency TEXT, source TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '[]', dedupe_key TEXT NOT NULL,
    posted_at TEXT, fetched_at TEXT NOT NULL, country TEXT, summary TEXT, summary_at TEXT)`;

export interface FakeJob {
  id: string;
  title: string;
  company?: string;
  companyKey?: string;
  location?: string | null;
  remote?: boolean;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  tags?: string[];
  postedAt?: string | null;
  fetchedAt?: string;
  country?: string | null;
  dedupeKey?: string;
}

/** SQLite з jobs_cache. Лічить усі інструкції, що дійшли до бази, щоб тест бачив, що запис не пройшов. */
export class FakeJobsDb extends SqliteD1 {
  readonly seen: string[] = [];

  constructor(private readonly clock: Date = new Date()) {
    super([]);
    this.sqlite.exec(JOBS_CACHE);
    this.beforeStatement = (sql) => { this.seen.push(sql); };
  }

  add(j: FakeJob): void {
    const company = j.company ?? "Acme Protocol";
    const iso = (daysAgo: number) => new Date(this.clock.getTime() - daysAgo * 86_400_000).toISOString();
    this.exec(
      `INSERT INTO jobs_cache (id, url, company, company_key, title, location, remote, salary_min, salary_max,
         salary_currency, source, tags, dedupe_key, posted_at, fetched_at, country)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'board:test', ?, ?, ?, ?, ?)`,
      j.id, `https://jobs.example/${j.id}`, company, j.companyKey ?? company.toLowerCase(), j.title,
      j.location === undefined ? "Remote" : j.location, j.remote === false ? 0 : 1,
      j.salaryMin ?? null, j.salaryMax ?? null, j.salaryCurrency ?? null,
      JSON.stringify(j.tags ?? ["web3"]), j.dedupeKey ?? `${company.toLowerCase()}|${j.title.toLowerCase()}`,
      j.postedAt === undefined ? iso(2) : j.postedAt, j.fetchedAt ?? iso(1), j.country ?? null);
  }
}
