"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { ERROR, FIELD, HINT, LABEL, TEXTAREA } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { CARD, Chip, H3, Notice, StageText } from "@/components/crm/ui";
import { Button } from "@/components/ui/button";
import { aboutRoleText, expiresInText, INTRO_STATUS_TEXT, roleText, STAGE_TEXT } from "@/lib/crm/labels";
import type { PipelineEvent } from "@/lib/crm/pipeline";
import type { Contact, RoleKey, Stage } from "@/lib/crm/types";
import { panelAction } from "./actions";
import type { PanelState } from "./panel-state";

const DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const FULL_DATE = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

export interface PanelProps {
  companyId: string;
  companyName: string;
  isAgency: boolean;
  candidateId: string;
  label: string;
  visible: boolean;
  contactMode: "approval" | "direct";
  roles: RoleKey[];
  defaultRole: RoleKey | null;
  jobs: { id: string; title: string }[];
  /** "Company site: acme.io (domain verified)" як у запиті кандидату; null без сайту. */
  siteLine: string | null;
  /** "Intros left …" для діалогу; null, коли межі немає. */
  quotaLine: string | null;
  canWrite: boolean;
  /** Демо-компанія (lib/admin/demo.ts): кнопки «відповісти за кандидата». */
  demo?: boolean;
  /** Відкрити діалог знайомства одразу (кнопка «Intro» з пошуку). */
  openIntro?: boolean;
  initial: PanelState;
}

function Hidden({ companyId, candidateId, op }: { companyId: string; candidateId: string; op: string }) {
  return (
    <>
      <input type="hidden" name="company_id" value={companyId} />
      <input type="hidden" name="candidate_id" value={candidateId} />
      <input type="hidden" name="op" value={op} />
    </>
  );
}

function eventText(e: PipelineEvent): string {
  const who = e.actor.kind === "agent" ? `Agent ${e.actor.name ?? ""}`.trim() : e.actor.kind === "member" ? (e.actor.name ?? "Teammate") : e.actor.kind === "candidate" ? "Candidate" : "NextCryptoJob";
  switch (e.kind) {
    case "added":
      return `${who} added to the pipeline`;
    case "stage_changed":
      return `${who} moved to ${e.to_stage ? STAGE_TEXT[e.to_stage] : "another stage"}`;
    case "note":
      return `${who}: "${e.body ?? ""}"`;
    case "tags_changed": {
      const tags = Array.isArray(e.meta?.tags) ? (e.meta.tags as string[]) : [];
      return tags.length ? `${who} set tags: ${tags.join(", ")}` : `${who} cleared the tags`;
    }
    case "job_linked":
      return `${who} linked a job`;
    case "intro_requested":
      return `${who} requested an intro`;
    case "intro_accepted":
      return "The candidate accepted the intro";
    case "intro_declined":
      return "The candidate declined the intro";
    case "intro_expired":
      return "No answer in 14 days";
    case "intro_canceled":
      return e.actor.kind === "system" ? "The intro was withdrawn" : `${who} withdrew the intro`;
    case "contact_shared":
      return e.actor.kind === "candidate" ? "The candidate shared their contact" : `${who} viewed the Telegram handle`;
    case "visibility_lost":
      return "The candidate is no longer visible";
    case "visibility_restored":
      return "The candidate is visible again";
  }
}

export function CandidatePanel(props: PanelProps) {
  const { companyId, candidateId, canWrite, visible } = props;
  const [state, action] = useActionState(panelAction, props.initial);
  const { card, intro } = state;
  const at = new Date(state.now);
  const h = { companyId, candidateId };
  const pendingIntro = intro && intro.status === "pending" ? intro : null;
  const contact = card?.contact ?? (intro?.contact ?? null);
  const moves: Stage[] = card
    ? (["found", "interview", "hired", "declined"] as Stage[]).filter(
        (s) => s !== card.stage && ((s !== "interview" && s !== "hired") || contact !== null),
      )
    : [];

  return (
    <aside aria-labelledby="panel-title" className="grid content-start gap-4">
      <h2 id="panel-title" className="sr-only">
        Your pipeline card
      </h2>
      {state.message ? <Notice tone="success">{state.message}</Notice> : null}
      {state.error ? <Notice tone="error">{state.error}</Notice> : null}

      <section aria-labelledby="stage-title" className={`${CARD} grid gap-3 p-4`}>
        <h3 id="stage-title" className={H3}>
          Pipeline
        </h3>
        {!card ? (
          <>
            <p className={HINT}>Not in your pipeline yet.</p>
            {canWrite && visible ? (
              <form action={action}>
                <Hidden {...h} op="add" />
                {props.defaultRole ? <input type="hidden" name="role" value={props.defaultRole} /> : null}
                <SubmitButton pendingLabel="Adding..." className="h-11 px-4 text-base">
                  Add to pipeline
                </SubmitButton>
              </form>
            ) : null}
          </>
        ) : (
          <>
            <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
              Stage: <StageText stage={card.stage} declinedBy={card.declined_by} />
            </p>
            {canWrite && card.stage !== "intro_requested" && moves.length ? (
              <form action={action} className="flex flex-wrap items-end gap-2">
                <Hidden {...h} op="move" />
                <div className="grid min-w-40 flex-1 gap-1.5">
                  <label htmlFor="move-stage" className={LABEL}>
                    Move to...
                  </label>
                  <select id="move-stage" name="stage" defaultValue="" required className={FIELD}>
                    <option value="" disabled>
                      Choose a stage
                    </option>
                    {moves.map((s) => (
                      <option key={s} value={s}>
                        {STAGE_TEXT[s]}
                      </option>
                    ))}
                  </select>
                </div>
                <SubmitButton pendingLabel="Moving..." variant="outline" className="h-11 px-4 text-base">
                  Move
                </SubmitButton>
              </form>
            ) : null}
            {card.stage === "intro_requested" ? <p className={HINT}>Waiting for the intro answer. Withdraw the request to move the card.</p> : null}
            {canWrite && !contact && card.stage !== "intro_requested" ? (
              <p className={HINT}>Interview and Hired open once the contact is shared.</p>
            ) : null}
          </>
        )}
      </section>

      {visible || contact || intro ? (
        <IntroSection {...props} state={state} action={action} contact={contact} pendingIntro={pendingIntro} at={at} />
      ) : null}

      {card ? (
        <>
          <section aria-labelledby="tags-title" className={`${CARD} grid gap-3 p-4`}>
            <h3 id="tags-title" className={H3}>
              Tags
            </h3>
            {card.tags.length ? (
              <ul className="flex flex-wrap gap-2">
                {card.tags.map((t) => (
                  <li key={t}>
                    <form action={action} className="inline-flex">
                      <Hidden {...h} op="tag_remove" />
                      <input type="hidden" name="tag" value={t} />
                      <Chip className="gap-1 py-0 pr-0">
                        {t}
                        {canWrite ? (
                          <button
                            type="submit"
                            className="inline-flex size-7 items-center justify-center rounded-[3px] text-ink-muted hover:bg-line hover:text-ink"
                            aria-label={`Remove tag ${t}`}
                          >
                            <span aria-hidden>&times;</span>
                          </button>
                        ) : null}
                      </Chip>
                    </form>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={HINT}>No tags yet.</p>
            )}
            {canWrite && card.tags.length < 10 ? (
              <form action={action} className="flex gap-2">
                <Hidden {...h} op="tag_add" />
                <label htmlFor="new-tag" className="sr-only">
                  New tag
                </label>
                <input
                  id="new-tag"
                  name="tag"
                  type="text"
                  maxLength={32}
                  placeholder="solidity"
                  aria-invalid={state.op === "tag_add" && state.fields?.tags ? true : undefined}
                  aria-describedby={state.op === "tag_add" && state.fields?.tags ? "tag-error" : undefined}
                  className={FIELD}
                />
                <SubmitButton pendingLabel="Adding..." variant="outline" className="h-11 shrink-0 px-4 text-base">
                  Add tag
                </SubmitButton>
              </form>
            ) : null}
            {state.op === "tag_add" && state.fields?.tags ? (
              <p id="tag-error" role="alert" className={ERROR}>
                {state.fields.tags}
              </p>
            ) : null}
          </section>

          <section aria-labelledby="note-title" className={`${CARD} grid gap-3 p-4`}>
            <h3 id="note-title" className={H3}>
              Add a note
            </h3>
            {canWrite ? (
              <NoteForm action={action} hidden={<Hidden {...h} op="note" />} state={state} />
            ) : (
              <p className={HINT}>Read-only: no active subscription.</p>
            )}
            <p className={HINT}>Only your team sees notes. Notes cannot be edited.</p>
          </section>

          <section aria-labelledby="history-title" className={`${CARD} grid gap-3 p-4`}>
            <h3 id="history-title" className={H3}>
              History
            </h3>
            {state.history.length ? (
              <ol className="grid gap-2">
                {state.history.map((e) => (
                  <li key={e.id} className="grid grid-cols-[3.5rem_1fr] gap-2 text-sm">
                    <time dateTime={e.created_at} className="font-mono text-xs text-ink-muted">
                      {DATE.format(new Date(e.created_at))}
                    </time>
                    <span className="break-words text-ink">{eventText(e)}</span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className={HINT}>Nothing yet.</p>
            )}
          </section>

          {canWrite ? (
            <details className={`${CARD} p-4`}>
              <summary className="min-h-11 cursor-pointer content-center text-sm font-semibold text-destructive">Remove from pipeline</summary>
              <form action={action} className="mt-3 grid gap-2">
                <Hidden {...h} op="remove" />
                <p className="text-sm text-ink">
                  Remove {props.label}? Notes and history are deleted{pendingIntro ? " and the pending intro is withdrawn" : ""}.
                </p>
                <SubmitButton pendingLabel="Removing..." variant="destructive" className="h-11 px-4 text-base sm:w-fit">
                  Remove from pipeline
                </SubmitButton>
              </form>
            </details>
          ) : null}
        </>
      ) : null}
    </aside>
  );
}

function NoteForm({ action, hidden, state }: { action: (f: FormData) => void; hidden: React.ReactNode; state: PanelState }) {
  const ref = useRef<HTMLFormElement>(null);
  // Збережено: поле порожнє для наступної нотатки.
  useEffect(() => {
    if (state.op === "note" && !state.error) ref.current?.reset();
  }, [state]);
  const error = state.op === "note" ? state.fields?.body : undefined;
  return (
    <form ref={ref} action={action} className="grid gap-2">
      {hidden}
      <label htmlFor="note-body" className="sr-only">
        Note
      </label>
      <textarea
        id="note-body"
        name="body"
        rows={3}
        maxLength={2000}
        required
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? "note-error" : undefined}
        className={TEXTAREA}
      />
      {error ? (
        <p id="note-error" role="alert" className={ERROR}>
          {error}
        </p>
      ) : null}
      <SubmitButton pendingLabel="Saving..." variant="outline" className="h-11 px-4 text-base sm:w-fit">
        Save
      </SubmitButton>
    </form>
  );
}

function IntroSection(
  props: PanelProps & {
    state: PanelState;
    action: (f: FormData) => void;
    contact: Contact | null;
    pendingIntro: PanelState["intro"];
    at: Date;
  },
) {
  const { state, action, contact, pendingIntro, at, canWrite, visible, companyId, candidateId } = props;
  const intro = state.intro;
  return (
    <section aria-labelledby="intro-title" className={`${CARD} grid gap-3 p-4`}>
      <h3 id="intro-title" className={H3}>
        Contact
      </h3>
      {contact ? (
        <div className="grid gap-1">
          <p className="text-sm text-ink-muted">{contact.kind === "telegram" ? "Telegram" : "Email"}</p>
          <p className="font-mono text-base break-all text-ink">{contact.value}</p>
          <p className={HINT}>
            Shared on {FULL_DATE.format(new Date(contact.shared_at))}
            {contact.via === "direct" ? ". The candidate chose to show it to companies." : " after the candidate accepted your intro."}
          </p>
        </div>
      ) : pendingIntro ? (
        <div className="grid gap-2">
          <p className="text-sm text-ink">
            Intro requested. {expiresInText(pendingIntro.expires_at, at)}.
          </p>
          {state.introNotice ? <Notice tone="warning">{state.introNotice}</Notice> : null}
          <p className={HINT}>The candidate sees your request and decides. If they accept, you get their Telegram here.</p>
          {props.demo ? (
            <div className="grid gap-2 rounded-lg border border-dashed border-line-strong bg-wash p-3" data-demo-answer="">
              <p className="text-sm text-ink">
                Demo candidate: they answer by themselves a few seconds after the request (reload the page), or answer for them now.
              </p>
              <div className="flex flex-wrap gap-2">
                {(["demo_accept", "demo_decline"] as const).map((op) => (
                  <form key={op} action={action}>
                    <Hidden companyId={companyId} candidateId={candidateId} op={op} />
                    <input type="hidden" name="intro_id" value={pendingIntro.intro_id} />
                    <SubmitButton pendingLabel="Answering..." variant={op === "demo_accept" ? "default" : "outline"} className="h-11 px-4 text-base">
                      {op === "demo_accept" ? "Simulate accept" : "Simulate decline"}
                    </SubmitButton>
                  </form>
                ))}
              </div>
            </div>
          ) : null}
          {canWrite ? (
            <form action={action}>
              <Hidden companyId={companyId} candidateId={candidateId} op="withdraw" />
              <input type="hidden" name="intro_id" value={pendingIntro.intro_id} />
              <SubmitButton pendingLabel="Withdrawing..." variant="outline" className="h-11 px-4 text-base">
                Withdraw request
              </SubmitButton>
            </form>
          ) : null}
        </div>
      ) : (
        <div className="grid gap-2">
          {intro ? (
            <p className="text-sm text-ink-muted">
              Last intro: {INTRO_STATUS_TEXT[intro.status] ?? intro.status}
              {intro.responded_at ? ` on ${FULL_DATE.format(new Date(intro.responded_at))}` : ""}.
            </p>
          ) : null}
          {!visible ? (
            <p className={HINT}>The candidate is no longer visible, so you cannot request an intro.</p>
          ) : canWrite ? (
            <IntroDialog {...props} />
          ) : (
            <p className={HINT}>Read-only: no active subscription.</p>
          )}
          <p className={HINT} data-contact-rule={props.contactMode}>
            {props.contactMode === "direct"
              ? "This candidate chose \u201cTelegram handle directly\u201d: you see their Telegram at once, and they are told you viewed it."
              : "The candidate sees your request and decides. If they accept, you get their Telegram (or email, if they have no Telegram)."}
          </p>
        </div>
      )}
    </section>
  );
}

const DEFAULT_DIRECT_MESSAGE = "Hi, we found your profile on NextCryptoJob and would like to talk about a role.";

/** Діалог запиту на знайомство (W5): повідомлення 20–600 з лічильником, вакансія, роль, що побачить кандидат, квота. */
function IntroDialog(props: PanelProps & { state: PanelState; action: (f: FormData) => void; at: Date }) {
  const { state, action, companyName, isAgency, roles, jobs, label, contactMode, at } = props;
  const ref = useRef<HTMLDialogElement>(null);
  const direct = contactMode === "direct";
  const [message, setMessage] = useState(direct ? DEFAULT_DIRECT_MESSAGE : "");
  const [role, setRole] = useState<string>(props.defaultRole ?? roles[0] ?? "");
  const [jobId, setJobId] = useState("");
  const [hiringFor, setHiringFor] = useState("");
  const fields = state.op === "intro" ? (state.fields ?? {}) : {};

  // Запит пройшов: діалог закривається, панель уже показує новий стан.
  useEffect(() => {
    if (state.op === "intro" && !state.error) ref.current?.close();
  }, [state]);

  // «Intro» з рядка пошуку: діалог відкритий одразу.
  const { openIntro } = props;
  useEffect(() => {
    if (openIntro && !ref.current?.open) ref.current?.showModal();
  }, [openIntro]);

  const len = message.trim().length;
  const expires = new Date(at.getTime() + 14 * 86_400_000);
  const job = jobs.find((j) => j.id === jobId);
  const trigger = direct ? "Show Telegram handle" : "Request intro";

  return (
    <>
      <Button type="button" className="h-11 px-4 text-base sm:w-fit" onClick={() => ref.current?.showModal()}>
        {trigger}
      </Button>
      <dialog
        ref={ref}
        aria-labelledby="intro-dialog-title"
        className="m-auto w-[min(40rem,calc(100vw-2rem))] rounded-xl border-2 border-ink bg-surface p-0 text-ink shadow-lift backdrop:bg-ink/40"
      >
        <form action={action} className="grid gap-4 p-4 sm:p-6">
          <Hidden companyId={props.companyId} candidateId={props.candidateId} op="intro" />
          <h2 id="intro-dialog-title" className="display text-[1.75rem] leading-none break-words">
            {direct ? `Show the Telegram handle of ${label}` : `Request intro with ${label}`}
          </h2>
          {direct ? (
            <Notice tone="info">
              This candidate chose &ldquo;Telegram handle directly&rdquo;: the handle appears here at once. They will be told
              that {companyName} viewed it.
            </Notice>
          ) : (
            <Notice tone="info">The candidate sees your request and decides. If they accept, you get their Telegram.</Notice>
          )}
          {state.op === "intro" && state.error ? <Notice tone="error">{state.error}</Notice> : null}
          <div className="grid gap-1.5">
            <label htmlFor="intro-message" className={LABEL}>
              Message (shown to the candidate)
            </label>
            <textarea
              id="intro-message"
              name="message"
              rows={4}
              maxLength={600}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              aria-invalid={fields.message ? true : undefined}
              aria-describedby="intro-message-count"
              className={TEXTAREA}
            />
            <p id="intro-message-count" className={`${HINT} text-right`} aria-live="polite">
              {len < 20 ? `${len} / 600, at least 20` : `${len} / 600`}
            </p>
            {fields.message ? (
              <p role="alert" className={ERROR}>
                {fields.message}
              </p>
            ) : null}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <label htmlFor="intro-job" className={LABEL}>
                Job
              </label>
              <select id="intro-job" name="job_id" value={jobId} onChange={(e) => setJobId(e.target.value)} className={FIELD}>
                <option value="">No job linked</option>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.title}
                  </option>
                ))}
              </select>
              {fields.job_id ? (
                <p role="alert" className={ERROR}>
                  {fields.job_id}
                </p>
              ) : null}
            </div>
            <div className="grid gap-1.5">
              <label htmlFor="intro-role" className={LABEL}>
                Role
              </label>
              <select id="intro-role" name="role" value={role} onChange={(e) => setRole(e.target.value)} className={FIELD}>
                {roles.map((r) => (
                  <option key={r} value={r}>
                    {roleText(r)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {isAgency ? (
            <div className="grid gap-1.5">
              <label htmlFor="intro-hiring-for" className={LABEL}>
                Hiring for
              </label>
              <input
                id="intro-hiring-for"
                name="hiring_for"
                type="text"
                maxLength={80}
                value={hiringFor}
                onChange={(e) => setHiringFor(e.target.value)}
                placeholder="Client name or Confidential client"
                aria-invalid={fields.hiring_for ? true : undefined}
                className={FIELD}
              />
              <p className={HINT}>The candidate sees this.</p>
              {fields.hiring_for ? (
                <p role="alert" className={ERROR}>
                  {fields.hiring_for}
                </p>
              ) : null}
            </div>
          ) : null}
          {!direct ? (
            <div className="grid gap-1 border border-line bg-wash p-3 text-sm">
              <p className="font-semibold text-ink">What the candidate sees</p>
              <p className="text-ink">
                {companyName} wants to talk to you {aboutRoleText(role)}.
              </p>
              {message.trim() ? <p className="break-words text-ink-muted">&ldquo;{message.trim()}&rdquo;</p> : null}
              {isAgency && hiringFor.trim() ? <p className="text-ink-muted">Hiring for: {hiringFor.trim()}</p> : null}
              {job ? <p className="text-ink-muted">Job: {job.title}</p> : null}
              {props.siteLine ? <p className="text-ink-muted">{props.siteLine}</p> : null}
              <p className="text-ink-muted">This request expires on {FULL_DATE.format(expires)}.</p>
            </div>
          ) : null}
          <p className={HINT}>
            {direct
              ? "No request and no waiting: the candidate turned this on in their settings."
              : "They have 14 days to answer. Without Telegram on their account you get their email instead. Until they accept, you never see a contact."}
            {props.quotaLine ? ` ${props.quotaLine}` : ""}
          </p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="outline" className="h-11 px-4 text-base" onClick={() => ref.current?.close()}>
              Cancel
            </Button>
            <SubmitButton pendingLabel="Sending..." disabled={len < 20 || len > 600} className="h-11 px-4 text-base">
              {direct ? "Show Telegram handle" : "Send intro request"}
            </SubmitButton>
          </div>
        </form>
      </dialog>
    </>
  );
}
