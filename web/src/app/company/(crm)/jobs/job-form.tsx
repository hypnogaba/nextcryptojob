"use client";

import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR, FIELD, HINT, LABEL, TEXTAREA } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { ROLES } from "@/lib/card/roles";
import type { Country } from "@/lib/crm/countries";
import { SALARY_CURRENCIES, type JobFormValues } from "@/lib/crm/job-form";
import { saveJobAction, type JobFormState } from "./actions";

/**
 * Форма вакансії (специфікація 10.2): "Title", "Roles", "Work mode", "City", "Country",
 * "Salary", "Apply URL", "Description", "Tags", "Post on @nextcryptojob (reviewed by
 * our team)". Кнопки залежать від стану: нова і чернетка "Save draft" / "Publish";
 * відкрита "Save changes"; закрита чи прострочена ще "Publish again".
 */

export type FormMode = "new" | "draft" | "open" | "reopen";

function Err({ id, text }: { id: string; text?: string }) {
  return text ? (
    <p id={id} role="alert" className={ERROR}>
      {text}
    </p>
  ) : null;
}

const describedBy = (e: Record<string, string>, name: string, hint = false) =>
  [e[name] ? `${name}-error` : null, hint ? `${name}-hint` : null].filter(Boolean).join(" ") || undefined;

const CHECK = "size-5 shrink-0 accent-brand";
const ROLE_KEYS = Object.keys(ROLES) as (keyof typeof ROLES)[];

export function JobForm({
  companyId,
  jobId,
  mode,
  initial,
  countries,
  xState,
}: {
  companyId: string;
  jobId?: string;
  mode: FormMode;
  initial: JobFormValues;
  countries: readonly Country[];
  xState: "none" | "queued" | "posted" | "skipped";
}) {
  const [state, action] = useActionState(saveJobAction, {} as JobFormState);
  const e = state.errors ?? {};
  // Після помилки форма показує те, з чим її відправили (React скидає поля до defaultValue).
  const v: JobFormValues = state.values ?? initial;

  return (
    <form action={action} className="grid gap-6" noValidate>
      <input type="hidden" name="company_id" value={companyId} />
      <input type="hidden" name="job_id" value={jobId ?? ""} />

      <div className="grid gap-1.5">
        <label htmlFor="title" className={LABEL}>
          Title
        </label>
        <input
          id="title"
          name="title"
          type="text"
          maxLength={120}
          required
          defaultValue={v.title}
          aria-invalid={e.title ? true : undefined}
          aria-describedby={describedBy(e, "title")}
          className={FIELD}
        />
        <Err id="title-error" text={e.title} />
      </div>

      <fieldset className="grid gap-2" aria-describedby={describedBy(e, "roles", true)}>
        <legend className={LABEL}>Roles</legend>
        <p id="roles-hint" className={HINT}>
          Choose 1 to 3. Candidates with one of these roles get the job in their digest.
        </p>
        <div className="grid grid-cols-1 gap-x-4 gap-y-1 sm:grid-cols-2">
          {ROLE_KEYS.map((r) => (
            <label key={r} className="flex min-h-11 items-center gap-3 text-sm text-ink">
              <input type="checkbox" name="roles" value={r} defaultChecked={v.roles.includes(r)} className={CHECK} />
              {ROLES[r].name}
            </label>
          ))}
        </div>
        <Err id="roles-error" text={e.roles} />
      </fieldset>

      <fieldset className="grid gap-2" aria-describedby={describedBy(e, "work_mode")}>
        <legend className={LABEL}>Work mode</legend>
        <div className="flex flex-wrap gap-x-6">
          <label className="flex min-h-11 items-center gap-3 text-sm text-ink">
            <input type="checkbox" name="work_mode" value="remote" defaultChecked={v.work_mode.includes("remote")} className={CHECK} />
            Remote
          </label>
          <label className="flex min-h-11 items-center gap-3 text-sm text-ink">
            <input type="checkbox" name="work_mode" value="city" defaultChecked={v.work_mode.includes("city")} className={CHECK} />
            City
          </label>
        </div>
        <Err id="work_mode-error" text={e.work_mode} />
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-1.5">
          <label htmlFor="city" className={LABEL}>
            City
          </label>
          <input
            id="city"
            name="city"
            type="text"
            maxLength={80}
            defaultValue={v.city}
            aria-invalid={e.city ? true : undefined}
            aria-describedby={describedBy(e, "city", true)}
            className={FIELD}
          />
          <p id="city-hint" className={HINT}>
            Needed for City. Candidates in this city get the job.
          </p>
          <Err id="city-error" text={e.city} />
        </div>
        <div className="grid content-start gap-1.5">
          <label htmlFor="country" className={LABEL}>
            Country
          </label>
          <select
            id="country"
            name="country"
            defaultValue={v.country}
            aria-invalid={e.country ? true : undefined}
            aria-describedby={describedBy(e, "country")}
            className={FIELD}
          >
            <option value="">Any or not set</option>
            {countries.map((c) => (
              <option key={c.code} value={c.code}>
                {c.name}
              </option>
            ))}
          </select>
          <Err id="country-error" text={e.country} />
        </div>
      </div>

      <fieldset className="grid gap-2" aria-describedby={describedBy(e, "salary", true)}>
        <legend className={LABEL}>Salary</legend>
        <p id="salary-hint" className={HINT}>
          Optional. Leave both amounts empty to hide the salary.
        </p>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <label className="grid gap-1 text-sm text-ink-muted">
            Min
            <input
              name="salary_min"
              type="text"
              inputMode="numeric"
              placeholder="120000"
              defaultValue={v.salary_min}
              aria-invalid={e.salary ? true : undefined}
              className={FIELD}
            />
          </label>
          <label className="grid gap-1 text-sm text-ink-muted">
            Max
            <input
              name="salary_max"
              type="text"
              inputMode="numeric"
              placeholder="150000"
              defaultValue={v.salary_max}
              aria-invalid={e.salary ? true : undefined}
              className={FIELD}
            />
          </label>
          <label className="grid gap-1 text-sm text-ink-muted">
            Currency
            <select name="salary_currency" defaultValue={v.salary_currency} className={FIELD}>
              {SALARY_CURRENCIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </label>
          <label className="grid gap-1 text-sm text-ink-muted">
            Period
            <select name="salary_period" defaultValue={v.salary_period} className={FIELD}>
              <option value="year">per year</option>
              <option value="month">per month</option>
            </select>
          </label>
        </div>
        <Err id="salary-error" text={e.salary} />
      </fieldset>

      <div className="grid gap-1.5">
        <label htmlFor="apply_url" className={LABEL}>
          Apply URL
        </label>
        <input
          id="apply_url"
          name="apply_url"
          type="text"
          inputMode="url"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="https://acme.io/careers/solidity or mailto:jobs@acme.io"
          defaultValue={v.apply_url}
          aria-invalid={e.apply_url ? true : undefined}
          aria-describedby={describedBy(e, "apply_url", true)}
          className={FIELD}
        />
        <p id="apply_url-hint" className={HINT}>
          Needed to publish. An https:// link or a mailto: address.
        </p>
        <Err id="apply_url-error" text={e.apply_url} />
      </div>

      <div className="grid gap-1.5">
        <label htmlFor="description" className={LABEL}>
          Description
        </label>
        <textarea
          id="description"
          name="description"
          rows={8}
          maxLength={5000}
          defaultValue={v.description}
          aria-invalid={e.description ? true : undefined}
          aria-describedby={describedBy(e, "description", true)}
          className={TEXTAREA}
        />
        <p id="description-hint" className={HINT}>
          Plain text, up to 5000 characters.
        </p>
        <Err id="description-error" text={e.description} />
      </div>

      <div className="grid gap-1.5">
        <label htmlFor="tags" className={LABEL}>
          Tags
        </label>
        <input
          id="tags"
          name="tags"
          type="text"
          placeholder="DeFi, Solidity, Lending"
          defaultValue={v.tags}
          aria-invalid={e.tags ? true : undefined}
          aria-describedby={describedBy(e, "tags", true)}
          className={FIELD}
        />
        <p id="tags-hint" className={HINT}>
          Separate with commas. Up to 10.
        </p>
        <Err id="tags-error" text={e.tags} />
      </div>

      {xState === "posted" ? (
        <p className="text-sm text-ink">Posted on @nextcryptojob.</p>
      ) : xState === "skipped" ? (
        <p className="text-sm text-ink-muted">Our team did not post this job on X.</p>
      ) : (
        <label className="flex min-h-11 items-start gap-3 text-sm text-ink">
          <input type="checkbox" name="post_on_x" defaultChecked={v.post_on_x} className={`${CHECK} mt-0.5`} />
          <span>
            Post on @nextcryptojob (reviewed by our team)
            <span className="block text-ink-muted">We post live jobs by hand. Unchecking withdraws the request.</span>
          </span>
        </label>
      )}

      <div className="grid gap-2">
        <Err id="status-error" text={e.status} />
        <div className="flex flex-col gap-2 sm:flex-row">
          {mode === "new" || mode === "draft" ? (
            <>
              <SubmitButton name="intent" value="open" pendingLabel="Publishing..." className="h-11 w-full px-5 text-base sm:w-fit">
                Publish
              </SubmitButton>
              <SubmitButton
                name="intent"
                value="draft"
                variant="outline"
                pendingLabel="Saving..."
                className="h-11 w-full px-5 text-base sm:w-fit"
              >
                Save draft
              </SubmitButton>
            </>
          ) : (
            <>
              <SubmitButton name="intent" value="save" pendingLabel="Saving..." className="h-11 w-full px-5 text-base sm:w-fit">
                Save changes
              </SubmitButton>
              {mode === "reopen" ? (
                <SubmitButton
                  name="intent"
                  value="open"
                  variant="outline"
                  pendingLabel="Publishing..."
                  className="h-11 w-full px-5 text-base sm:w-fit"
                >
                  Publish again for 60 days
                </SubmitButton>
              ) : null}
            </>
          )}
        </div>
        <FormMessageLine message={state.message} />
      </div>
    </form>
  );
}
