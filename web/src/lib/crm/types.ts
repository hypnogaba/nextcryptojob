import { z } from "zod";
import { ROLES, type RoleKey as RoleKeyType } from "@/lib/card/roles";

/**
 * zod-схеми, що дзеркалять docs/api/openapi.yaml#/components/schemas
 * (специфікація CRM, 3.1). Реєстр дій (actions.ts) бере звідси вхід і вихід
 * кожної дії; той самий опис обслуговує інтерфейс, REST і MCP.
 *
 * Вхідні схеми суворі (additionalProperties: false в openapi): зайве поле це
 * помилка клієнта, а не тихе ігнорування. Вихідні не суворі: поля лише додаємо.
 *
 * Тест actions.test.ts звіряє ці схеми з openapi.yaml і mcp-tools.md за типами,
 * переліченнями й межами (z.toJSONSchema проти розгорнутих схем договору).
 */

// ---------------------------------------------------------------------------
// Помилки

/** Коди з openapi.yaml#/components/schemas/Error (`forbidden` бачить лише інтерфейс, див. permissions.ts). */
export const ERROR_CODES = [
  "unauthorized",
  "invalid_api_key",
  "key_revoked",
  "key_required",
  "company_not_active",
  "subscription_required",
  "trial_limit",
  "quota_exceeded",
  "daily_quota_exceeded",
  "rate_limited",
  "not_found",
  "candidate_not_available",
  "candidate_not_visible",
  "intro_already_open",
  "intro_cooldown",
  "intro_not_pending",
  "invalid_stage_transition",
  "contact_not_shared",
  "page_cap_reached",
  "payment_reused",
  "webhook_not_set",
  "validation_failed",
  "not_configured",
  "internal",
  "not_implemented",
  "forbidden",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Помилка дії: код з договору, HTTP-статус, текст англійською для людини
 * (без довгого тире) і необов'язкові подробиці (`details.fields`, `retry_after`…).
 */
export class ActionError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
    /** Заголовки відповіді, напр. RateLimit-* і Retry-After для 429. */
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "ActionError";
  }

  /** Тіло помилки REST і structuredContent MCP. */
  body(requestId: string) {
    return {
      error: {
        code: this.code,
        message: this.message,
        request_id: requestId,
        ...(this.details ? { details: this.details } : {}),
      },
    };
  }
}

/** validation_failed з `details.fields` (шлях поля → повідомлення) з помилки zod. */
export function validationError(error: z.ZodError): ActionError {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.map(String).join(".") || "(root)";
    fields[path] ??= issue.message;
  }
  return new ActionError("validation_failed", 422, "Some fields are not valid.", { fields });
}

// ---------------------------------------------------------------------------
// Перелічення

/**
 * Чинна версія формули балу (docs/contracts.md §4; engine/src/formula/score.ts FORMULA_VERSION).
 * Порожній пошук з фільтром балу каже scores_not_published, доки ворота якості цієї версії не пройдено.
 */
export const FORMULA_VERSION = "v9";

const ROLE_KEYS = Object.keys(ROLES) as [RoleKeyType, ...RoleKeyType[]];
export const RoleKey = z.enum(ROLE_KEYS);
export type RoleKey = RoleKeyType;

export const CHAINS = ["ethereum", "base", "arbitrum", "optimism", "solana", "hyperliquid"] as const;
export const Chain = z.enum(CHAINS);
export type Chain = z.infer<typeof Chain>;

export const STAGES = ["found", "intro_requested", "contact_shared", "interview", "hired", "declined"] as const;
export const Stage = z.enum(STAGES);
export type Stage = z.infer<typeof Stage>;

export const IntroStatus = z.enum(["pending", "accepted", "declined", "expired", "canceled", "direct"]);
export type IntroStatus = z.infer<typeof IntroStatus>;

/** Джерела балу (contracts §4). `audits` і `dune` додала формула v5; в openapi.yaml їх ще немає. */
export const SOURCE_KEYS = [
  "gh_eng",
  "gh_builder",
  "x",
  "yt",
  "media",
  "output",
  "onchain",
  "trading",
  "site",
  "audits",
  "dune",
  // v7 (17.09): посилання на роботи, репутація, найсильніше джерело.
  "links",
  "rep",
  "best",
] as const;
export const SourceKey = z.enum(SOURCE_KEYS);
export type SourceKey = z.infer<typeof SourceKey>;

export const SORTS = ["score", "level", "coverage", "newest"] as const;
export const Sort = z.enum(SORTS);
export type Sort = z.infer<typeof Sort>;

export const UNSCORED_REASONS = ["missing_anchor", "needs_cv", "needs_portfolio", "not_published", "pending"] as const;
export const UnscoredReason = z.enum(UNSCORED_REASONS);
export type UnscoredReason = z.infer<typeof UnscoredReason>;

export const EMPTY_REASONS = ["scores_not_published", "no_visible_candidates_for_role", "filters_too_narrow"] as const;
export type EmptyReason = (typeof EMPTY_REASONS)[number];

// ---------------------------------------------------------------------------
// Спільні шматки

const IsoDateTime = z.iso.datetime();
const IsoDate = z.iso.date();
export const CandidateId = z.uuid();
export const JobId = z.string().regex(/^job_[A-Za-z0-9]{20}$/);
export const IntroId = z.string().regex(/^int_[A-Za-z0-9]{20}$/);
export const SavedSearchId = z.string().regex(/^ss_[A-Za-z0-9]{20}$/);
export const Cursor = z.string().max(512);
const Limit50 = z.number().int().min(1).max(50);
const Limit20 = z.number().int().min(1).max(20);
/** Ключ порівняння тегу: без розрізнення регістру для будь-якої абетки (Solidity = solidity = ＳＯＬＩＤＩＴＹ). */
export function tagKey(tag: string): string {
  return tag.normalize("NFKC").trim().toLowerCase();
}

/**
 * Повтори без огляду на регістр прибираються ДО межі в 10 (лишається перше
 * написання): 10 різних тегів і "T0" поруч з "t0" це 10 тегів, як і в
 * normalizeTags (pipeline.ts). Не масив чи не рядки лишаються як є: їх відкине схема.
 */
function dedupeTags(value: unknown): unknown {
  if (!Array.isArray(value) || !value.every((t) => typeof t === "string")) return value;
  const seen = new Set<string>();
  return value.filter((t: string) => {
    const key = tagKey(t);
    if (key === "") return true; // порожній тег лишаємо: його відкине min(1) чи normalizeTags
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const Tags = z.preprocess(dedupeTags, z.array(z.string().min(1).max(32)).max(10));
const WorkModes = z.array(z.enum(["remote", "city"])).min(1);

function uniqueItems<T>(list: readonly T[] | undefined): boolean {
  return !list || new Set(list).size === list.length;
}

// ---------------------------------------------------------------------------
// Пошук

export const SearchFilters = z
  .strictObject({
    role: RoleKey.optional(),
    min_score: z.number().int().min(0).max(100).optional(),
    min_level: z.number().int().min(1).max(10).optional(),
    max_level: z.number().int().min(1).max(10).optional(),
    chains: z.array(Chain).max(6).optional(),
    min_onchain_years: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(6)]).optional(),
    work_mode: z.enum(["remote", "city"]).optional(),
    city: z.string().max(80).optional(),
    x_verified: z.boolean().optional(),
    wallet_verified: z.boolean().optional(),
    min_coverage: z.number().int().min(0).max(100).optional(),
    contact_direct: z.boolean().optional(),
    exclude_in_pipeline: z.boolean().optional(),
  })
  .refine((f) => uniqueItems(f.chains), { path: ["chains"], message: "Each chain can be listed once." })
  .refine((f) => f.work_mode !== "city" || (f.city ?? "").trim().length > 0, {
    path: ["city"],
    message: "Choose a city when searching by city.",
  })
  .refine((f) => f.min_level === undefined || f.max_level === undefined || f.min_level <= f.max_level, {
    path: ["max_level"],
    message: "Max level must be at least the min level.",
  });
export type SearchFilters = z.infer<typeof SearchFilters>;

export const SearchRequest = z.strictObject({
  filters: SearchFilters.optional(),
  sort: Sort.optional(),
  limit: Limit20.optional(),
  cursor: Cursor.optional(),
});
export type SearchRequest = z.infer<typeof SearchRequest>;

export const RoleScore = z.object({
  role: RoleKey,
  score: z.number().int().min(0).max(100).nullable(),
  level: z.number().int().min(1).max(10).nullable(),
  coverage: z.number().int().min(0).max(100).nullable(),
  unscored_reason: UnscoredReason.nullable(),
});
export type RoleScore = z.infer<typeof RoleScore>;

export const ScoreBreakdown = z.object({
  core: z.array(
    z.object({ source: SourceKey, label: z.string(), weight: z.number().int(), value: z.number().int().nullable() }),
  ),
  bonus: z.array(
    z.object({ source: SourceKey, label: z.string(), max: z.number().int(), value: z.number().int().nullable() }),
  ),
  gaps: z.array(z.object({ source: z.string(), label: z.string() })),
  formula_version: z.string(),
  updated_at: IsoDateTime,
});
export type ScoreBreakdown = z.infer<typeof ScoreBreakdown>;

export const RoleScoreDetailed = RoleScore.extend({ breakdown: ScoreBreakdown.nullable() });
export type RoleScoreDetailed = z.infer<typeof RoleScoreDetailed>;

export const Badges = z.object({
  x_verified: z.boolean(),
  wallet: z.enum(["signature_verified", "not_signature_verified", "none"]),
  github_linked: z.boolean(),
  youtube_linked: z.boolean(),
  site_linked: z.boolean(),
});
export type Badges = z.infer<typeof Badges>;

export const CandidateWalletLink = z.object({
  chain: z.enum(["evm", "solana"]),
  address: z.string(),
  explorer_url: z.url(),
});
export type CandidateWalletLink = z.infer<typeof CandidateWalletLink>;

/**
 * Прямі посилання на облікові записи кандидата (власник 14.09, C4: компанія бачить усе
 * одразу, без запиту знайомства). Лише поки видимо (не null) або опт-аут: `linksVisible`
 * у lib/crm/project.ts, той самий перемикач, що й пряма показ Telegram-ніку. Пошта сюди
 * не входить: пошту компанія бачить лише після прийнятого запиту (окреме поле `contact`).
 */
export const CandidateLinks = z.object({
  telegram: z.string().nullable(),
  x: z.url().nullable(),
  github: z.url().nullable(),
  youtube: z.url().nullable(),
  website: z.url().nullable(),
  wallets: z.array(CandidateWalletLink),
});
export type CandidateLinks = z.infer<typeof CandidateLinks>;

export const PipelineBrief = z.object({ stage: Stage, tags: z.array(z.string()) });

export const CandidateSummary = z.object({
  candidate_id: CandidateId,
  visibility: z.literal("visible"),
  label: z.string(),
  headline: RoleScore,
  roles: z.array(RoleScore),
  work: z.object({ modes: z.array(z.enum(["remote", "city"])), city: z.string().nullable() }),
  salary_floor: z.object({ amount: z.number().int(), currency: z.string() }).nullable(),
  chains: z.array(Chain),
  onchain_years: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(4), z.literal(6)]).nullable(),
  badges: Badges,
  contact_mode: z.enum(["approval", "direct"]),
  pipeline: PipelineBrief.nullable().optional(),
});
export type CandidateSummary = z.infer<typeof CandidateSummary>;

export const SearchResponse = z.object({
  data: z.array(CandidateSummary),
  next_cursor: z.string().nullable(),
  page: z.number().int().min(1).max(10),
  page_cap_reached: z.boolean().optional(),
  empty_reason: z.enum(EMPTY_REASONS).nullable().optional(),
  role_visible_count: z.number().int().nullable().optional(),
});
export type SearchResponse = z.infer<typeof SearchResponse>;

export const Contact = z.object({
  kind: z.enum(["telegram", "email"]),
  value: z.string(),
  shared_at: IsoDateTime,
  via: z.enum(["intro", "direct"]),
});
export type Contact = z.infer<typeof Contact>;

// ---------------------------------------------------------------------------
// Знайомства

export const IntroCreate = z.strictObject({
  candidate_id: CandidateId,
  message: z.string().min(20).max(600),
  role: RoleKey.optional(),
  job_id: JobId.optional(),
  hiring_for: z.string().min(2).max(80).optional(),
});

export const Intro = z.object({
  intro_id: z.string(),
  candidate_id: CandidateId,
  status: IntroStatus,
  mode: z.enum(["approval", "direct"]),
  message: z.string(),
  hiring_for: z.string().nullable().optional(),
  role: RoleKey.nullable(),
  job_id: z.string().nullable(),
  created_at: IsoDateTime,
  expires_at: IsoDateTime,
  responded_at: IsoDateTime.nullable(),
  requested_via: z.enum(["web", "rest", "mcp"]),
  candidate_notified: z.boolean().optional(),
  contact: Contact.nullable(),
  webhook: z.object({
    state: z.enum(["none", "pending", "delivered", "failed"]),
    attempts: z.number().int().optional(),
    last_error: z.string().nullable().optional(),
  }),
});
export type Intro = z.infer<typeof Intro>;

export const IntroList = z.object({ data: z.array(Intro), next_cursor: z.string().nullable() });

export const CandidateProfile = CandidateSummary.extend({
  roles_detailed: z.array(RoleScoreDetailed),
  intro: Intro.nullable(),
  contact: Contact.nullable(),
  /** null while the candidate has opted out of "Show my Telegram directly" in Settings. */
  links: CandidateLinks.nullable(),
});
export type CandidateProfile = z.infer<typeof CandidateProfile>;

export const HIDDEN_NOTICE = "Candidate is no longer visible";

export const HiddenCandidate = z.object({
  candidate_id: CandidateId,
  visibility: z.literal("hidden"),
  label: z.string(),
  notice: z.literal(HIDDEN_NOTICE),
  pipeline: PipelineBrief,
  contact: Contact.nullable(),
});
export type HiddenCandidate = z.infer<typeof HiddenCandidate>;

export const CandidateView = z.discriminatedUnion("visibility", [CandidateProfile, HiddenCandidate]);
export type CandidateView = z.infer<typeof CandidateView>;

// ---------------------------------------------------------------------------
// Воронка

export const PipelineAdd = z.strictObject({
  role: RoleKey.optional(),
  job_id: JobId.optional(),
  tags: Tags.optional(),
});

export const PipelineUpdate = z.strictObject({
  stage: z.enum(["found", "interview", "hired", "declined"]).optional(),
  tags: Tags.optional(),
  job_id: JobId.nullable().optional(),
});

export const PipelineCard = z.object({
  candidate_id: CandidateId,
  label: z.string(),
  visibility: z.enum(["visible", "hidden"]),
  stage: Stage,
  declined_by: z.enum(["candidate", "company"]).nullable(),
  tags: z.array(z.string()),
  note_count: z.number().int(),
  role: RoleKey.nullable(),
  job_id: z.string().nullable(),
  headline: RoleScore.nullable(),
  contact: Contact.nullable(),
  open_intro: z.object({ intro_id: z.string(), expires_at: IsoDateTime }).nullable(),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  stage_changed_at: IsoDateTime,
});

export const PipelineList = z.object({
  data: z.array(PipelineCard),
  next_cursor: z.string().nullable(),
  counts: z.record(z.string(), z.number().int()),
});

export const PipelineEventKind = z.enum([
  "added",
  "stage_changed",
  "note",
  "tags_changed",
  "job_linked",
  "intro_requested",
  "intro_accepted",
  "intro_declined",
  "intro_expired",
  "intro_canceled",
  "contact_shared",
  "visibility_lost",
  "visibility_restored",
]);

export const PipelineEvent = z.object({
  id: z.number().int(),
  kind: PipelineEventKind,
  from_stage: Stage.nullable().optional(),
  to_stage: Stage.nullable().optional(),
  body: z.string().nullable().optional(),
  meta: z.record(z.string(), z.unknown()).nullable().optional(),
  actor: z.object({ kind: z.enum(["member", "agent", "candidate", "system"]), name: z.string().nullable().optional() }),
  created_at: IsoDateTime,
});

export const PipelineEventList = z.object({ data: z.array(PipelineEvent), next_cursor: z.string().nullable() });

export const NoteCreate = z.strictObject({ body: z.string().min(1).max(2000) });

// ---------------------------------------------------------------------------
// Вакансії

const Salary = z
  .object({
    min: z.number().int().min(0).nullable().optional(),
    max: z.number().int().min(0).nullable().optional(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    period: z.enum(["year", "month"]),
  })
  .nullable();

const JobFields = {
  title: z.string().min(3).max(120),
  description: z.string().max(5000),
  roles: z.array(RoleKey).min(1).max(3),
  work_mode: WorkModes,
  city: z.string().max(80).nullable(),
  country: z
    .string()
    .regex(/^[A-Z]{2}$/)
    .nullable(),
  salary: Salary,
  apply_url: z.url().nullable(),
  tags: Tags,
};

const uniqueJobLists = <T extends { roles?: readonly string[]; work_mode?: readonly string[] }>(j: T) =>
  uniqueItems(j.roles) && uniqueItems(j.work_mode);

export const JobCreate = z
  .strictObject({
    title: JobFields.title,
    description: JobFields.description.optional(),
    roles: JobFields.roles,
    work_mode: JobFields.work_mode,
    city: JobFields.city.optional(),
    country: JobFields.country.optional(),
    salary: JobFields.salary.optional(),
    apply_url: JobFields.apply_url.optional(),
    tags: JobFields.tags.optional(),
    status: z.enum(["draft", "open"]).optional(),
    post_on_x: z.boolean().optional(),
  })
  .refine(uniqueJobLists, { message: "Roles and work modes can be listed once each." });

export const JobUpdate = z
  .strictObject({
    title: JobFields.title.optional(),
    description: JobFields.description.optional(),
    roles: JobFields.roles.optional(),
    work_mode: JobFields.work_mode.optional(),
    city: JobFields.city.optional(),
    country: JobFields.country.optional(),
    salary: JobFields.salary.optional(),
    apply_url: JobFields.apply_url.optional(),
    tags: JobFields.tags.optional(),
    status: z.enum(["draft", "open"]).optional(),
    post_on_x: z.boolean().optional(),
  })
  .refine(uniqueJobLists, { message: "Roles and work modes can be listed once each." });

export const Job = z.object({
  job_id: z.string(),
  status: z.enum(["draft", "open", "closed"]),
  title: JobFields.title,
  description: JobFields.description.optional(),
  roles: JobFields.roles,
  work_mode: JobFields.work_mode,
  city: JobFields.city.optional(),
  country: JobFields.country.optional(),
  salary: JobFields.salary.optional(),
  apply_url: JobFields.apply_url.optional(),
  tags: JobFields.tags.optional(),
  live: z.boolean(),
  created_at: IsoDateTime,
  updated_at: IsoDateTime,
  published_at: IsoDateTime.nullable(),
  expires_at: IsoDateTime.nullable(),
  closed_at: IsoDateTime.nullable(),
  public_url: z.string().nullable(),
  x_post: z.object({ state: z.enum(["none", "queued", "posted", "skipped"]), url: z.string().nullable().optional() }),
  stats: z.object({ digest_shown: z.number().int(), apply_clicks: z.number().int() }),
});

export const JobList = z.object({ data: z.array(Job), next_cursor: z.string().nullable() });

export const PublicJob = z.object({
  job_id: z.string(),
  source: z.enum(["company", "crawl"]),
  title: z.string(),
  company: z.string(),
  company_domain_verified: z.boolean().optional(),
  work_mode: z.array(z.enum(["remote", "city"])),
  city: z.string().nullable(),
  salary: z
    .object({
      min: z.number().int().nullable().optional(),
      max: z.number().int().nullable().optional(),
      currency: z.string().nullable().optional(),
      period: z.enum(["year", "month"]).nullable().optional(),
    })
    .nullable(),
  roles: z.array(RoleKey),
  url: z.string(),
  posted_at: IsoDateTime.nullable(),
  /** Дошка, яку треба назвати джерелом (зараз лише «web3.career», умови їхнього API); без поля для решти. */
  via: z.string().optional(),
  /**
   * Оцінка зарплати від дошки (web3.career), лише коли `salary` немає. Не зарплата роботодавця:
   * фільтр salary_min її не бачить. `source` каже, чия оцінка.
   */
  salary_estimate: z
    .object({
      min: z.number().int().nullable(),
      max: z.number().int().nullable(),
      currency: z.string().nullable(),
      period: z.enum(["year", "month"]),
      source: z.string(),
    })
    .optional(),
  /**
   * Сайт компанії («https://arbitrum.io»), знайдений у реєстрі бази вакансій (db/jobs 0005); null,
   * якщо домену не знаємо. Лише для вакансій зі сканування: у вакансії компанії є своя сторінка на сайті.
   */
  company_url: z.string().nullable(),
  /**
   * Ринкові дані токена компанії (db/jobs 0004), лише свіжі ціни (не старші за 3 доби); null, якщо
   * токена немає, ціна ще не свіжа, або (як і company_url) це вакансія компанії, а не зі сканування.
   */
  company_token: z
    .object({
      symbol: z.string(),
      price_usd: z.number(),
      mcap_usd: z.number().nullable(),
      change_24h: z.number().nullable(),
      updated_at: IsoDateTime,
    })
    .nullable(),
});

export const PublicJobList = z.object({ data: z.array(PublicJob), next_cursor: z.string().nullable() });

// ---------------------------------------------------------------------------
// Збережені пошуки

export const SavedSearch = z.object({
  saved_search_id: z.string(),
  name: z.string(),
  filters: SearchFilters,
  sort: Sort,
  alert: z.enum(["off", "daily"]),
  last_alert_at: IsoDateTime.nullable(),
  last_match_count: z.number().int().nullable(),
  created_at: IsoDateTime,
});

export const SavedSearchList = z.object({ data: z.array(SavedSearch) });

export const SavedSearchCreate = z.strictObject({
  name: z.string().min(1).max(80),
  filters: SearchFilters,
  sort: Sort.optional(),
  alert: z.enum(["off", "daily"]).optional(),
});

export const SavedSearchUpdate = z.strictObject({
  name: z.string().min(1).max(80).optional(),
  filters: SearchFilters.optional(),
  sort: Sort.optional(),
  alert: z.enum(["off", "daily"]).optional(),
});

// ---------------------------------------------------------------------------
// Вебхук

export const Webhook = z.object({
  url: z.url().nullable(),
  enabled: z.boolean(),
  events: z.array(z.enum(["intro.accepted", "intro.declined", "intro.expired"])),
  failing_since: IsoDateTime.nullable(),
  secret: z.string().nullable(),
});
export type Webhook = z.infer<typeof Webhook>;

export const WebhookUpdate = z.strictObject({
  url: z.url().max(500).optional(),
  enabled: z.boolean().optional(),
  rotate_secret: z.boolean().optional(),
});

export const WebhookTestResult = z.object({
  delivered: z.boolean(),
  status_code: z.number().int().nullable(),
  error: z.string().nullable().optional(),
  duration_ms: z.number().int().optional(),
});

// ---------------------------------------------------------------------------
// Рахунок і оплата

export const QuotaState = z.object({
  limit: z.number().int().nullable(),
  remaining: z.number().int().nullable(),
  resets_at: IsoDateTime,
});

export const Account = z.object({
  company: z.object({
    company_id: z.string(),
    name: z.string(),
    kind: z.enum(["company", "agency"]),
    status: z.enum(["pending_review", "active", "suspended", "rejected", "closed"]),
    domain_verified: z.boolean(),
  }),
  access: z.object({
    mode: z.enum(["subscription", "pay_per_request", "none"]),
    subscription_status: z.string().nullable(),
    period_end: IsoDateTime.nullable(),
    trial: z.boolean(),
  }),
  quotas: z.record(z.string(), QuotaState),
  x402: z
    .object({
      enabled: z.boolean(),
      networks: z.array(z.string()),
      prices_usd: z.record(z.string(), z.string()),
    })
    .optional(),
  /** null для члена команди в інтерфейсі (у openapi.yaml поле обов'язкове: там завжди ключ). */
  key: z.object({ key_id: z.string(), name: z.string(), prefix: z.string() }).nullable(),
});
export type Account = z.infer<typeof Account>;

export const Usage = z.object({
  from: IsoDate,
  to: IsoDate,
  days: z.array(z.object({ date: IsoDate, action: z.string(), calls: z.number().int(), x402_usd: z.string() })),
  totals: z.object({ calls: z.number().int(), x402_usd: z.string() }),
});

export const UsdcMonthResult = z.object({
  subscription_id: z.string(),
  period_end: IsoDateTime,
  payment_id: z.string(),
});

/** Порожній об'єкт: вхід дій без параметрів і вихід DELETE (REST 204). */
export const Empty = z.strictObject({});

export { IsoDate, IsoDateTime, Limit20, Limit50, Tags };
