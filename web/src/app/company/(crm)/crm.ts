import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { cache } from "react";
import { requireUser, type SessionUser } from "@/lib/auth/session";
import { loadApplication, type Application } from "@/lib/crm/agency";
import { listMemberships, touchMember, type Membership } from "@/lib/crm/company";
import { COMPANY_COOKIE, resolveWebActor, type ActionContext, type CompanyInfo } from "@/lib/crm/context";
import { ActionError } from "@/lib/crm/types";

/**
 * Спільне для сторінок CRM (/company/…): хто людина, у якій компанії зараз,
 * які ще компанії є (перемикач), заявка агенції. React cache: layout і сторінка
 * одного запиту читають базу один раз.
 *
 * Правило доступу сторінок (специфікація 6.2, 10.1): поки компанія не `active`
 * (агенція на перевірці, відхилена, призупинена, закрита), відкриті лише
 * налаштування (і заявка для агенції). Решта сторінок веде туди.
 */

export interface CrmView {
  user: SessionUser;
  ctx: ActionContext;
  role: "owner" | "member";
  company: CompanyInfo;
  memberships: Membership[];
  /** Найновіша заявка агенції; null для компанії або якщо заявки ще немає. */
  application: Application | null;
}

export type CrmPage =
  | "dashboard"
  | "search"
  | "candidates"
  | "pipeline"
  | "saved-searches"
  | "team"
  | "billing"
  | "developers"
  | "settings"
  | "apply";

export const COMPANY_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 365 * 24 * 60 * 60,
};

/** Людина з сесії в поточній компанії або null (не член жодної). Без сесії: /login. */
export const loadCrm = cache(async (): Promise<CrmView | null> => {
  const user = await requireUser();
  let ctx: ActionContext;
  try {
    ctx = await resolveWebActor();
  } catch (err) {
    if (err instanceof ActionError && err.status === 401) return null;
    throw err;
  }
  if (ctx.actor.kind !== "member" || !ctx.company) return null;
  const [memberships, application] = await Promise.all([
    listMemberships(ctx.db, user.id),
    ctx.company.kind === "agency" ? loadApplication(ctx.db, ctx.company.id) : Promise.resolve(null),
  ]);
  await touchMember(ctx.db, user.id, ctx.company.id);
  return { user, ctx, role: ctx.actor.role, company: ctx.company, memberships, application };
});

/** Чи відкрита сторінка для компанії в цьому стані. */
export function pageAllowed(page: CrmPage, company: Pick<CompanyInfo, "status" | "kind">): boolean {
  if (page === "settings") return true;
  if (page === "apply") return company.kind === "agency";
  return company.status === "active";
}

/** Куди вести, коли сторінка закрита: агенція без заявки до форми, решта в налаштування. */
export function fallbackPage(view: Pick<CrmView, "company" | "application">): string {
  if (view.company.kind === "agency" && view.company.status === "pending_review") {
    return !view.application || view.application.status === "needs_info" ? "/company/apply" : "/company/settings";
  }
  return "/company/settings";
}

/** Сторінка CRM: людина в компанії й сторінка відкрита, інакше перехід. */
export async function crmPage(page: CrmPage): Promise<CrmView> {
  const view = await loadCrm();
  if (!view) redirect("/company/start");
  if (!pageAllowed(page, view.company)) redirect(fallbackPage(view));
  return view;
}

/** Поставити поточну компанію (кукі `ncj_company`). Лише в server action. */
export async function setCurrentCompany(companyId: string): Promise<void> {
  (await cookies()).set(COMPANY_COOKIE, companyId, COMPANY_COOKIE_OPTIONS);
}

export async function clearCurrentCompany(): Promise<void> {
  (await cookies()).delete(COMPANY_COOKIE);
}
