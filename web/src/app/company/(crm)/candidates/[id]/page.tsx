import type { Metadata } from "next";
import Link from "next/link";
import { MiniCard } from "@/components/card/mini-card";
import { POS } from "@/components/board";
import { CARD, H2, LINK, NoAccess, Notice } from "@/components/crm/ui";
import { fnv1a } from "@/lib/card/pattern";
import { POSITION_CODE } from "@/lib/roles/recipes";
import { isRoleKey } from "@/lib/card/roles";
import { readAction, runAction } from "@/lib/crm/actions";
import { loadCompanyProfile, userFacingError } from "@/lib/crm/company";
import {
  badgeTexts,
  CHAIN_TEXT,
  contactModeText,
  onchainYearsText,
  roleScoreText,
  salaryText,
  unscoredText,
  workText,
} from "@/lib/crm/labels";
import { companyIntroNotice } from "@/lib/crm/notify";
import type { PipelineEvent } from "@/lib/crm/pipeline";
import { CandidateId, type Account, type CandidateView, type RoleKey } from "@/lib/crm/types";
import { candidatePanel, companyJobs } from "@/lib/crm/views";
import { crmPage } from "../../crm";
import { CandidatePanel } from "./candidate-panel";
import { RoleTabs } from "./role-tabs";

export const metadata: Metadata = { title: "Candidate", robots: { index: false } };

function quotaLine(quotas: Account["quotas"]): string | null {
  const month = quotas.request_intro_month;
  const day = quotas.request_intro_day;
  const parts: string[] = [];
  if (month && month.limit !== null && month.remaining !== null) parts.push(`Intros left this month: ${month.remaining} of ${month.limit}.`);
  if (day && day.limit !== null && day.remaining !== null) parts.push(`Today: ${day.remaining} of ${day.limit}.`);
  return parts.length ? parts.join(" ") : null;
}

/**
 * Профіль кандидата очима компанії (специфікація 5.3, 10.2 W3): анонімна шапка
 * з головним балом, вкладки ролей з поясненням по джерелах, позначки; праворуч
 * картка воронки (етап, теги, нотатки, історія) і знайомство (W5). Контакт лише
 * після «так» або в режимі direct. Прихований кандидат: сіра шапка "Candidate is
 * no longer visible", лише власні нотатки, історія й контакт, якщо був.
 * Кожен показ сторінки це один get_candidate: квота переглядів і рядок журналу.
 */
export default async function CandidatePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { ctx, company } = await crmPage("candidates");
  const { id } = await params;
  const query = await searchParams;
  const roleParam = typeof query.role === "string" && isRoleKey(query.role) ? query.role : null;

  const back = (
    <Link href="/company/search" className={`${LINK} inline-flex min-h-11 items-center text-sm`}>
      Back to search
    </Link>
  );
  const shell = (children: React.ReactNode) => (
    <div className="mx-auto grid max-w-5xl grid-cols-1 gap-5 px-[clamp(16px,4vw,56px)] pt-6 pb-20 sm:pt-8">
      <div className="-my-2 flex flex-wrap gap-x-5">
        {back}
        <Link href="/company/pipeline" className={`${LINK} inline-flex min-h-11 items-center text-sm`}>
          Pipeline
        </Link>
      </div>
      {children}
    </div>
  );

  if (company.access === "none") return shell(<NoAccess />);
  if (!CandidateId.safeParse(id).success) return shell(<Notice tone="warning">This candidate is not available.</Notice>);

  let view: CandidateView;
  try {
    view = (await runAction("get_candidate", { candidate_id: id }, ctx)).output as CandidateView;
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    return shell(<Notice tone={known.code === "candidate_not_available" ? "warning" : "error"}>{known.message}</Notice>);
  }

  const canWrite = company.access === "subscription";
  const [panel, jobs, account, profileRow] = await Promise.all([
    candidatePanel(ctx, id),
    companyJobs(ctx),
    readAction("get_account", {}, ctx).then((out) => out as Account),
    loadCompanyProfile(ctx.db, company.id),
  ]);
  const history = panel.card
    ? ((await readAction("list_candidate_history", { candidate_id: id, limit: 50 }, ctx)) as { data: PipelineEvent[] }).data
    : [];

  const profile = view.visibility === "visible" ? view : null;
  const visible = profile !== null;
  const roles: RoleKey[] = profile ? profile.roles.map((r) => r.role) : [];
  const defaultRole: RoleKey | null =
    (roleParam && roles.includes(roleParam) ? roleParam : null) ??
    (panel.card?.role && roles.includes(panel.card.role) ? panel.card.role : null) ??
    (profile ? profile.headline.role : null);

  const panelEl = (
    <CandidatePanel
      companyId={company.id}
      companyName={company.name}
      isAgency={company.kind === "agency"}
      candidateId={id}
      label={view.label}
      visible={visible}
      contactMode={profile ? profile.contact_mode : "approval"}
      roles={roles}
      defaultRole={defaultRole}
      jobs={jobs.filter((j) => j.linkable).map((j) => ({ id: j.id, title: j.title }))}
      siteLine={profileRow?.domain ? `Company site: ${profileRow.domain}${profileRow.domainVerifiedAt ? " (domain verified)" : ""}` : null}
      quotaLine={quotaLine(account.quotas)}
      canWrite={canWrite}
      initial={{
        card: panel.card,
        intro: panel.intro,
        history,
        introNotice: panel.intro ? companyIntroNotice(panel.intro) : null,
        now: ctx.now.toISOString(),
      }}
    />
  );

  if (view.visibility === "hidden") {
    return shell(
      <>
        <header className="grid gap-2 rounded-xl border border-dashed border-line-strong bg-wash p-4 sm:p-6">
          <h1 className="display text-title text-ink-muted">{view.label}</h1>
          <p className="font-semibold text-ink">{view.notice}</p>
          <p className="text-sm text-ink-muted">You keep your own notes, the history and a contact that was already shared. No new data about this person.</p>
        </header>
        <div className="max-w-xl">{panelEl}</div>
      </>,
    );
  }

  const h = view.headline;
  const others = view.roles.filter((r) => r.role !== h.role);
  const facts = [
    workText(view.work),
    salaryText(view.salary_floor),
    view.chains.map((c) => CHAIN_TEXT[c]).join(", "),
    onchainYearsText(view.onchain_years),
  ].filter(Boolean);
  const badges = badgeTexts(view.badges);

  return shell(
    <>
      <header className={`${CARD} grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-4 gap-y-2 p-4 sm:gap-x-6 sm:p-6`}>
        {h.score !== null && h.level !== null ? (
          <MiniCard level={h.level} seed={fnv1a(view.label)} value={h.score} className="row-span-2 w-16 sm:row-span-3 sm:w-24" />
        ) : (
          <span aria-hidden="true" className="row-span-2 inline-block aspect-[0.718] w-16 rounded-[4.55%/3.5%] border border-dashed border-line-strong sm:row-span-3 sm:w-24" />
        )}
        <div className="grid min-w-0 gap-1">
          <div className="flex flex-wrap items-baseline gap-x-3">
            <h1 className="display text-title">{view.label}</h1>
            <span className={POS}>{POSITION_CODE[h.role]}</span>
          </div>
          {h.score !== null ? (
            <p className="text-base text-ink">
              <span className="font-semibold">{roleScoreText(h)}</span>
              <span className="text-ink-muted">
                {" "}
                · Level {h.level} · Coverage {h.coverage ?? 0}%
              </span>
            </p>
          ) : (
            <p className="text-base text-ink-muted">{unscoredText(h.role, h.unscored_reason)}</p>
          )}
          {others.length ? <p className="text-sm text-ink-muted">Also: {others.map(roleScoreText).join(", ")}</p> : null}
        </div>
        <div className="col-span-2 grid gap-1 border-t border-line pt-3 sm:col-span-1 sm:col-start-2">
          <p className="text-sm text-ink">{facts.join(" · ")}</p>
          {badges.length ? <p className="text-sm text-ink-muted">{badges.join(" · ")}</p> : null}
          <p className="text-sm text-ink-muted">{contactModeText(view.contact_mode)}</p>
        </div>
      </header>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <section aria-labelledby="scores-title" className={`${CARD} grid min-w-0 gap-4 p-4 sm:p-6`}>
          <h2 id="scores-title" className={H2}>
            Scores by role
          </h2>
          <RoleTabs roles={view.roles_detailed} initial={roleParam ?? h.role} />
        </section>
        {panelEl}
      </div>
    </>,
  );
}
