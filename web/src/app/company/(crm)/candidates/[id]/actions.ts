"use server";

import { answerDemoIntro } from "@/lib/admin/demo";
import { prepareAction, readAction, runAction } from "@/lib/crm/actions";
import { assertFormCompany, userFacingError } from "@/lib/crm/company";
import { crmActionActor, type ActionContext } from "@/lib/crm/context";
import { STAGE_TEXT } from "@/lib/crm/labels";
import { companyIntroNotice, notifierFromEnv } from "@/lib/crm/notify";
import { changeTag } from "@/lib/crm/pipeline";
import { ActionError, CandidateId, IntroId, type Intro, type Stage } from "@/lib/crm/types";
import { candidatePanel } from "@/lib/crm/views";
import type { PanelState } from "./panel-state";

/**
 * Дії панелі картки на сторінці профілю (W3, W5). Одна точка входу з полем `op`:
 * актор із сесії, прихований id компанії порівнюється з компанією сесії, кожна
 * зміна йде через реєстр дій (право, доступ, журнал, квота знайомств). Після зміни
 * дія повертає свіжий стан картки, знайомства й історії, а сторінку не
 * оновлює: повторний показ профілю витратив би ще один перегляд з денної квоти.
 */

const MOVABLE: readonly Stage[] = ["found", "interview", "hired", "declined"];

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === "string" ? v : "";
}

async function snapshot(
  ctx: ActionContext,
  candidateId: string,
): Promise<Pick<PanelState, "card" | "intro" | "history" | "introNotice" | "now">> {
  const panel = await candidatePanel(ctx, candidateId);
  const history = panel.card
    ? ((await readAction("list_candidate_history", { candidate_id: candidateId, limit: 50 }, ctx)) as {
        data: PanelState["history"];
      }).data
    : [];
  return {
    card: panel.card,
    intro: panel.intro,
    history,
    introNotice: panel.intro ? companyIntroNotice(panel.intro) : null,
    now: new Date().toISOString(),
  };
}

async function perform(ctx: ActionContext, op: string, id: string, form: FormData): Promise<{ message: string; intro?: Intro }> {
  switch (op) {
    case "add":
      await runAction("add_to_pipeline", { candidate_id: id, ...(text(form, "role") ? { role: text(form, "role") } : {}) }, ctx);
      return { message: "Added to your pipeline." };
    case "move": {
      const stage = text(form, "stage") as Stage;
      if (!MOVABLE.includes(stage)) {
        throw new ActionError("validation_failed", 422, "Choose where to move the card.", { fields: { stage: "Choose a stage." } });
      }
      await runAction("update_stage", { candidate_id: id, stage }, ctx);
      return { message: `Moved to ${STAGE_TEXT[stage]}.` };
    }
    case "tag_add": {
      const tag = text(form, "tag").trim();
      if (!tag) throw new ActionError("validation_failed", 422, "Write a tag first.", { fields: { tags: "Write a tag first." } });
      // Право й доступ тієї самої дії реєстру (update_stage); сама зміна одним UPDATE над поточним списком.
      prepareAction("update_stage", { candidate_id: id, tags: [tag.slice(0, 32)] }, ctx);
      await changeTag(ctx, { candidate_id: id, add: tag });
      return { message: "Tags saved." };
    }
    case "tag_remove": {
      const tag = text(form, "tag").trim();
      if (!tag) throw new ActionError("validation_failed", 422, "Choose a tag to remove.");
      prepareAction("update_stage", { candidate_id: id, tags: [] }, ctx);
      await changeTag(ctx, { candidate_id: id, remove: tag });
      return { message: "Tag removed." };
    }
    case "note":
      await runAction("add_note", { candidate_id: id, body: text(form, "body") }, ctx);
      return { message: "Note saved." };
    case "remove":
      await runAction("remove_from_pipeline", { candidate_id: id }, ctx);
      return { message: "Removed from your pipeline. Its notes and history are deleted." };
    case "intro": {
      const input: Record<string, string> = { candidate_id: id, message: text(form, "message") };
      for (const k of ["role", "job_id", "hiring_for"]) if (text(form, k).trim()) input[k] = text(form, k).trim();
      const intro = (await runAction("request_intro", input, ctx)).output as Intro;
      return {
        intro,
        message:
          intro.status === "direct"
            ? "Here is the Telegram handle. The candidate was told that you viewed it."
            : "Intro request sent. The candidate has 14 days to answer.",
      };
    }
    case "withdraw": {
      const introId = text(form, "intro_id");
      if (!IntroId.safeParse(introId).success) throw new ActionError("not_found", 404, "This intro was not found.");
      await runAction("cancel_intro", { intro_id: introId }, ctx);
      return { message: "Request withdrawn. The card is back in Found." };
    }
    case "demo_accept":
    case "demo_decline": {
      // Лише демо-компанія і лише її знайомство з демо-кандидатом (lib/admin/demo.ts).
      const introId = text(form, "intro_id");
      if (!ctx.company?.isDemo || !IntroId.safeParse(introId).success) {
        throw new ActionError("forbidden", 403, "Only a demo company can answer for a demo candidate.");
      }
      const decision = op === "demo_accept" ? "accept" : "decline";
      const res = await answerDemoIntro(ctx.db, { companyId: ctx.company.id, introId, decision, notifier: notifierFromEnv(ctx.env) });
      if (!res.ok) {
        throw new ActionError("not_found", 404, res.reason === "not_pending" ? "This intro is already answered." : "This is not a demo intro.");
      }
      return {
        message: decision === "accept" ? "Demo: the candidate accepted. Their Telegram handle is below." : "Demo: the candidate declined.",
      };
    }
    default:
      throw new ActionError("validation_failed", 422, "Unknown action.");
  }
}

export async function panelAction(prev: PanelState, form: FormData): Promise<PanelState> {
  const op = text(form, "op");
  const candidateId = text(form, "candidate_id");
  if (!CandidateId.safeParse(candidateId).success) return { ...prev, op, error: "This candidate is not available.", message: undefined };
  try {
    const ctx = await crmActionActor();
    assertFormCompany(ctx, form.get("company_id"));
    const done = await perform(ctx, op, candidateId, form);
    return { ...(await snapshot(ctx, candidateId)), op, message: done.message };
  } catch (err) {
    const known = userFacingError(err);
    if (!known) throw err;
    return { ...prev, op, error: known.message, fields: known.fields, message: undefined };
  }
}
