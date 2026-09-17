// Перенесено з NextRole (crypto-jobs-agent, scanner): src/types.ts, лише те, що потрібне крипто-сканеру.
// Сканер вакансій NextCryptoJob: власний, пише лише в базу вакансій NextCryptoJob (db/jobs).

/** Вакансія так, як її віддало джерело, до будь-якої нормалізації. */
export interface RawJob {
  url: string;
  company: string;
  title: string;
  location: string | null;
  remote: boolean;
  /** ISO або null, якщо джерело дати не дає. */
  postedAt: string | null;
  source: string;
  salaryMin?: number | null;
  salaryMax?: number | null;
  salaryCurrency?: string | null;
  /**
   * Крипто за словом самого джерела: компанія з крипто-реєстру, крипто-дошка, крипто-компанія
   * speedrun, або дошка сама позначила вакансію крипто (JobStash). false = у базу не йде.
   */
  crypto: boolean;
  /**
   * Сирий текст оголошення. У базу НЕ потрапляє: з нього лише витягується вилка
   * (salary-text.ts), якщо джерело не дало її окремим полем.
   */
  description?: string | null;
  /**
   * Стійкий ключ вакансії для id рядка, коли адреса може мінятись або несе мітки джерела
   * (web3.career: номер вакансії, а `url` це їхній apply_url, який не можна правити). Без нього id
   * з адреси (ids.ts). В базу окремо не пишеться.
   */
  idKey?: string | null;
  /** Теги самої дошки (web3.career): з них лише сфери для підказки ролі (tags.ts boardSpheres). */
  boardTags?: readonly string[];
  /**
   * Оцінка зарплати від самої дошки (web3.career `estimated_*`), річна. НЕ вилка роботодавця: іде
   * лише в salary_est_* (db/jobs/0002), ніколи в salary_min/max, підбір чи лічильник «з зарплатою».
   */
  salaryEstimate?: SalaryEstimate | null;
}

export interface SalaryEstimate { min: number | null; max: number | null; currency: string | null }

/** Рядок jobs_cache, готовий до запису. */
export interface JobRow {
  id: string;
  url: string;
  company: string;
  companyKey: string;
  title: string;
  location: string | null;
  remote: boolean;
  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  /** Оцінка дошки (RawJob.salaryEstimate), окремо від вилки; null, якщо її немає. */
  salaryEstMin: number | null;
  salaryEstMax: number | null;
  salaryEstCurrency: string | null;
  source: string;
  tags: string[];
  dedupeKey: string;
  postedAt: string | null;
  fetchedAt: string;
}

/** Що повертає одне джерело. Джерело не кидає винятків назовні (runSource). */
export interface SourceResult {
  source: string;
  ok: boolean;
  jobs: RawJob[];
  error?: string;
  /** 429: джерело живе, але просить прийти пізніше. Днем збою не рахується. */
  rateLimited?: boolean;
}

export const ATS_PROVIDERS = [
  "greenhouse", "lever", "lever_eu", "ashby", "workable", "smartrecruiters", "recruitee", "teamtailor",
  "breezy", "bamboohr", "rippling", "personio", "gem", "pinpoint", "hibob", "comeet", "workday",
] as const;
export type AtsProvider = (typeof ATS_PROVIDERS)[number];
export const isAtsProvider = (v: unknown): v is AtsProvider =>
  typeof v === "string" && (ATS_PROVIDERS as readonly string[]).includes(v);

/** Роботодавець з реєстру (таблиця companies). */
export interface Company {
  slug: string;
  name: string;
  provider: AtsProvider;
  atsSlug: string;
}

export type SourceKind = "jsonld" | "nextjs" | "rss" | "speedrun";

/** Дошка чи агрегатор (таблиця sources). */
export interface BoardSource {
  name: string;
  label: string;
  kind: SourceKind;
  feedUrl: string;
  /** true: кожна вакансія крипто; false: лише ті, що дошка сама позначила крипто. */
  cryptoOnly: boolean;
}

/** Рядок source_state: джерело, що падало. Здорового джерела в таблиці немає. */
export interface SourceState {
  source: string;
  status: "failing" | "dead";
  failDays: number;
  lastError: string | null;
  failedAt: string;
  checkedAt: string;
}

export interface GetroCollection {
  id: number;
  label: string;
}
