import { isoTime, sqlTime } from "@/lib/time";
import { actorRole, type ActionContext, type CompanyInfo } from "./context";
import { FORMER_MEMBER, memberLabels } from "./company";
import { heldSql } from "./intros";
import { STAGE_TEXT } from "./labels";
import { assertCan } from "./permissions";
import { getCard, type PipelineCard } from "./pipeline";
import { candidateLabel, INTRO_COLUMNS, projectIntro, type IntroRow } from "./project";
import { ActionError, STAGES, type Intro, type Stage } from "./types";

/**
 * Читання для екранів CRM (специфікація 10.2, T7), яких немає серед 28 дій API:
 * зведення дашборду, стрічка подій воронки, відкриті вакансії для діалогу
 * знайомства, стан однієї картки для панелі профілю. Лише читання, завжди в
 * межах company_id актора, з правом з матриці 2.2 (assertCan). Усі зміни йдуть
 * через реєстр дій (actions.ts).
 */

type CompanyCtx = ActionContext & { company: CompanyInfo };

function companyOf(ctx: ActionContext): CompanyCtx {
  if (!ctx.company) throw new ActionError("unauthorized", 401, "Sign in or send an API key.");
  return ctx as CompanyCtx;
}

// ---------------------------------------------------------------------------
// Відкриті вакансії (для вибору в запиті на знайомство і фільтра воронки)

export interface JobOption {
  id: string;
  title: string;
  status: "draft" | "open" | "closed";
  /** Вакансію можна прив'язати до знайомства: відкрита, не прихована, не прострочена. */
  linkable: boolean;
}

/** Вакансії компанії: відкриті першими, потім чернетки й закриті (до 50). */
export async function companyJobs(ctx: ActionContext): Promise<JobOption[]> {
  const c = companyOf(ctx);
  assertCan(actorRole(c.actor), "jobs.read");
  const { results } = await c.db
    .prepare(
      `SELECT id, title, status,
              (status = 'open' AND hidden_by_admin_at IS NULL AND expires_at IS NOT NULL AND expires_at > ?) AS linkable
         FROM company_jobs WHERE company_id = ?
        ORDER BY (status = 'open') DESC, (status = 'draft') DESC, updated_at DESC LIMIT 50`,
    )
    .bind(sqlTime(c.now), c.company.id)
    .all<{ id: string; title: string; status: JobOption["status"]; linkable: number }>();
  return results.map((r) => ({ id: r.id, title: r.title, status: r.status, linkable: r.linkable === 1 }));
}

// ---------------------------------------------------------------------------
// Панель картки на сторінці профілю

export interface CandidatePanel {
  card: PipelineCard | null;
  /** Найновіше знайомство пари (без броні до оплати). */
  intro: Intro | null;
}

/** Картка воронки й останнє знайомство цієї компанії з кандидатом. */
export async function candidatePanel(ctx: ActionContext, candidateId: string): Promise<CandidatePanel> {
  const c = companyOf(ctx);
  assertCan(actorRole(c.actor), "pipeline.read");
  assertCan(actorRole(c.actor), "intros.read");
  const [card, intro] = await Promise.all([
    getCard(c.db, c.company.id, candidateId),
    c.db
      .prepare(
        `SELECT ${INTRO_COLUMNS} FROM intros WHERE company_id = ? AND user_id = ? AND NOT ${heldSql()}
          ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
      .bind(c.company.id, candidateId)
      .first<IntroRow>(),
  ]);
  return { card, intro: intro ? projectIntro(intro) : null };
}

// ---------------------------------------------------------------------------
// Стрічка подій воронки (дашборд, W1)

export interface ActivityItem {
  id: number;
  /** ISO 8601 з Z. */
  at: string;
  candidateId: string;
  label: string;
  text: string;
}

interface EventRow {
  id: number;
  kind: string;
  to_stage: Stage | null;
  actor_kind: "member" | "agent" | "candidate" | "system";
  actor_user_id: string | null;
  key_name: string | null;
  user_id: string;
  created_at: string;
}

function stageName(stage: Stage | null): string {
  return stage ? STAGE_TEXT[stage] : "another stage";
}

/** Текст події для людини; `who` уже підписаний, `c` це мітка кандидата. */
export function activityLine(kind: string, who: string, c: string, toStage: Stage | null, actorKind: EventRow["actor_kind"]): string {
  switch (kind) {
    case "added":
      return `${who} added ${c} to the pipeline`;
    case "stage_changed":
      return `${who} moved ${c} to ${stageName(toStage)}`;
    case "note":
      return `${who} added a note on ${c}`;
    case "tags_changed":
      return `${who} changed tags of ${c}`;
    case "job_linked":
      return `${who} linked a job to ${c}`;
    case "intro_requested":
      return `${who} requested an intro with ${c}`;
    case "intro_accepted":
      return `${c} accepted your intro`;
    case "intro_declined":
      return `${c} declined your intro`;
    case "intro_expired":
      return `No answer from ${c} in 14 days`;
    case "intro_canceled":
      return actorKind === "system" ? `The intro with ${c} was withdrawn` : `${who} withdrew the intro with ${c}`;
    case "contact_shared":
      return actorKind === "candidate" ? `${c} shared their contact` : `${who} viewed the Telegram handle of ${c}`;
    case "visibility_lost":
      return `${c} is no longer visible`;
    case "visibility_restored":
      return `${c} is visible again`;
    default:
      return `${who} changed ${c}`;
  }
}

/** Останні події воронки компанії, найновіша першою. */
export async function recentActivity(ctx: ActionContext, limit = 10): Promise<ActivityItem[]> {
  const c = companyOf(ctx);
  assertCan(actorRole(c.actor), "pipeline.read");
  const { results } = await c.db
    .prepare(
      `SELECT e.id, e.kind, e.to_stage, e.actor_kind, e.actor_user_id, e.created_at, p.user_id, k.name AS key_name
         FROM pipeline_events e
         JOIN pipeline p ON p.id = e.pipeline_id AND p.company_id = e.company_id
         LEFT JOIN api_keys k ON k.id = e.actor_key_id AND k.company_id = e.company_id
        WHERE e.company_id = ?
        ORDER BY e.id DESC LIMIT ?`,
    )
    .bind(c.company.id, limit)
    .all<EventRow>();
  const members = await memberLabels(
    c.db,
    c.company.id,
    results.flatMap((r) => (r.actor_kind === "member" && r.actor_user_id ? [r.actor_user_id] : [])),
  );
  return results.map((r) => {
    const label = candidateLabel(r.user_id);
    const who =
      r.actor_kind === "member"
        ? r.actor_user_id
          ? (members.get(r.actor_user_id) ?? FORMER_MEMBER)
          : FORMER_MEMBER
        : r.actor_kind === "agent"
          ? `Agent ${r.key_name ?? "(deleted key)"}`
          : r.actor_kind === "candidate"
            ? label
            : "NextCryptoJob";
    return {
      id: r.id,
      at: isoTime(r.created_at),
      candidateId: r.user_id,
      label,
      text: activityLine(r.kind, who, label, r.to_stage, r.actor_kind),
    };
  });
}

// ---------------------------------------------------------------------------
// Дашборд (W1)

export interface DashboardJob {
  id: string;
  title: string;
  status: "draft" | "open" | "closed";
  live: boolean;
  digestShown: number;
  applyClicks: number;
}

export interface Dashboard {
  counts: Record<Stage, number>;
  total: number;
  intros: {
    pending: number;
    /** Найближче прострочення серед тих, що чекають (ISO), або null. */
    nextExpiry: string | null;
    /** Скільки з тих, що чекають, ще не дійшли до кандидата. */
    notReached: number;
  };
  savedSearches: { total: number; alerts: number; newMatches: number; withNew: number };
  jobs: DashboardJob[];
}

/** Зведення для дашборду одним пакетом запитів. */
export async function loadDashboard(ctx: ActionContext): Promise<Dashboard> {
  const c = companyOf(ctx);
  const role = actorRole(c.actor);
  assertCan(role, "pipeline.read");
  assertCan(role, "intros.read");
  const id = c.company.id;
  const now = sqlTime(c.now);
  const [countRes, introRes, searchRes, jobRes] = await c.db.batch([
    c.db.prepare("SELECT stage, COUNT(*) AS n FROM pipeline WHERE company_id = ? GROUP BY stage").bind(id),
    c.db
      .prepare(
        `SELECT COUNT(*) AS pending, MIN(expires_at) AS next_expiry, SUM(notified_at IS NULL) AS not_reached
           FROM intros WHERE company_id = ? AND status = 'pending' AND respond_token_hash IS NOT NULL AND expires_at > ?`,
      )
      .bind(id, now),
    // «Нові збіги» рахує сповіщення (cron): кількість останнього сповіщення за добу.
    c.db
      .prepare(
        `SELECT COUNT(*) AS total, SUM(alert = 'daily') AS alerts,
                SUM(CASE WHEN last_alert_at > datetime(?, '-1 day') THEN COALESCE(last_match_count, 0) ELSE 0 END) AS new_matches,
                SUM(last_alert_at > datetime(?, '-1 day') AND COALESCE(last_match_count, 0) > 0) AS with_new
           FROM saved_searches WHERE company_id = ?`,
      )
      .bind(now, now, id),
    c.db
      .prepare(
        `SELECT j.id, j.title, j.status, j.digest_shown, j.apply_clicks,
                EXISTS (SELECT 1 FROM company_jobs_live l WHERE l.id = j.id) AS live
           FROM company_jobs j WHERE j.company_id = ? AND j.status <> 'closed'
          ORDER BY (j.status = 'open') DESC, j.updated_at DESC LIMIT 5`,
      )
      .bind(id),
  ]);
  const counts = Object.fromEntries(STAGES.map((s) => [s, 0])) as Record<Stage, number>;
  for (const r of countRes.results as { stage: Stage; n: number }[]) counts[r.stage] = r.n;
  const i = (introRes.results[0] ?? {}) as { pending?: number; next_expiry?: string | null; not_reached?: number | null };
  const s = (searchRes.results[0] ?? {}) as { total?: number; alerts?: number | null; new_matches?: number | null; with_new?: number | null };
  return {
    counts,
    total: Object.values(counts).reduce((a, b) => a + b, 0),
    intros: {
      pending: i.pending ?? 0,
      nextExpiry: i.next_expiry ? isoTime(i.next_expiry) : null,
      notReached: i.not_reached ?? 0,
    },
    savedSearches: {
      total: s.total ?? 0,
      alerts: s.alerts ?? 0,
      newMatches: s.new_matches ?? 0,
      withNew: s.with_new ?? 0,
    },
    jobs: (
      jobRes.results as { id: string; title: string; status: DashboardJob["status"]; digest_shown: number; apply_clicks: number; live: number }[]
    ).map((j) => ({
      id: j.id,
      title: j.title,
      status: j.status,
      live: j.live === 1,
      digestShown: j.digest_shown,
      applyClicks: j.apply_clicks,
    })),
  };
}
