import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AdminNav } from "@/components/admin-nav";
import { Ago, NUM, Panel } from "@/components/admin-ui";
import { BOARD, TABLE, TD_TIGHT, TH_TIGHT, TR } from "@/components/board";
import { FIELD, HINT, LABEL } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { codeTables, engineKeyReport, workerConfig, type ConfigItem, type EngineKeyReport } from "@/lib/admin/config";
import { parseDbTime } from "@/lib/admin/job-sources";
import {
  BANNER_LEVELS,
  BANNER_MAX_LENGTH,
  loadSettings,
  SETTINGS,
  SETTINGS_CACHE_TTL_MS,
  type AppSettings,
  type LoadedSettings,
  type SettingKey,
} from "@/lib/admin/settings";
import { currentAdmin } from "@/lib/auth/admin";
import { appEnv, db } from "@/lib/db";
import { cn } from "@/lib/utils";
import { saveSettingsAction, type SettingsError } from "./actions";

export const metadata: Metadata = { title: "Settings", robots: { index: false } };

/**
 * Адмінка: що можна змінити одразу (app_settings, lib/admin/settings.ts) і що лише для
 * читання (змінні Worker, ключі рушія на VPS, числа з коду: lib/admin/config.ts).
 */

const ERRORS: Record<SettingsError, string> = {
  not_admin: "Only admins can do this.",
  unavailable: "Settings cannot be saved: the app_settings table is missing (migration 0019 is not applied yet).",
  signups_open: "Choose Open or Closed for candidate sign-ups.",
  company_signups_open: "Choose Open or Closed for company sign-ups.",
  banner_message: `Keep the notice under ${BANNER_MAX_LENGTH} characters.`,
  banner_level: "Choose Info or Warning.",
};

const RADIO_ROW =
  "flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-3 text-sm font-semibold transition-colors " +
  "hover:border-line-strong has-[:checked]:border-ink has-[:checked]:shadow-[inset_0_0_0_1px_var(--ink)]";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function Changed({ loaded, keyName, now }: { loaded: LoadedSettings; keyName: SettingKey; now: number }) {
  const meta = loaded.meta[keyName];
  if (!meta) return <span className="text-xs text-ink-muted">Default, never changed</span>;
  return (
    <span className="text-xs text-ink-muted">
      Changed <Ago at={parseDbTime(meta.updatedAt)} now={now} />
    </span>
  );
}

function OpenClosed({ name, value, labelledBy }: { name: SettingKey; value: boolean; labelledBy: string }) {
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex flex-wrap gap-2">
      <label className={RADIO_ROW}>
        <input type="radio" name={name} value="true" defaultChecked={value} className="size-4" />
        Open
      </label>
      <label className={RADIO_ROW}>
        <input type="radio" name={name} value="false" defaultChecked={!value} className="size-4" />
        Closed
      </label>
    </div>
  );
}

function SignupsForm({ values, loaded, now }: { values: AppSettings; loaded: LoadedSettings; now: number }) {
  const keys: SettingKey[] = ["signups_open", "company_signups_open"];
  return (
    <form action={saveSettingsAction} className="grid gap-5" data-form="signups">
      <input type="hidden" name="keys" value={keys.join(",")} />
      {keys.map((key) => (
        <fieldset key={key} className="grid gap-2">
          <legend id={`${key}-label`} className={LABEL}>
            {SETTINGS[key].label}
          </legend>
          <OpenClosed name={key} value={values[key] as boolean} labelledBy={`${key}-label`} />
          <p className={HINT}>{SETTINGS[key].help}</p>
          <Changed loaded={loaded} keyName={key} now={now} />
        </fieldset>
      ))}
      <div>
        <SubmitButton className="h-11 px-4" pendingLabel="Saving...">
          Save sign-ups
        </SubmitButton>
      </div>
    </form>
  );
}

function NoticeForm({ values, loaded, now }: { values: AppSettings; loaded: LoadedSettings; now: number }) {
  return (
    <form action={saveSettingsAction} className="grid gap-5" data-form="notice">
      <input type="hidden" name="keys" value="banner_message,banner_level" />
      <div className="grid gap-1.5">
        <label htmlFor="banner_message" className={LABEL}>
          {SETTINGS.banner_message.label}
        </label>
        <input
          id="banner_message"
          name="banner_message"
          type="text"
          maxLength={BANNER_MAX_LENGTH}
          defaultValue={values.banner_message}
          placeholder="Digests are late today. We are on it."
          aria-describedby="banner_message-help"
          className={FIELD}
        />
        <p id="banner_message-help" className={HINT}>
          {SETTINGS.banner_message.help}
        </p>
        <Changed loaded={loaded} keyName="banner_message" now={now} />
      </div>
      <fieldset className="grid gap-2">
        <legend id="banner_level-label" className={LABEL}>
          {SETTINGS.banner_level.label}
        </legend>
        <div role="radiogroup" aria-labelledby="banner_level-label" className="flex flex-wrap gap-2">
          {BANNER_LEVELS.map((level) => (
            <label key={level} className={RADIO_ROW}>
              <input type="radio" name="banner_level" value={level} defaultChecked={values.banner_level === level} className="size-4" />
              {level === "info" ? "Info" : "Warning"}
            </label>
          ))}
        </div>
        <p className={HINT}>{SETTINGS.banner_level.help}</p>
      </fieldset>
      <div>
        <SubmitButton className="h-11 px-4" pendingLabel="Saving...">
          Save notice
        </SubmitButton>
      </div>
    </form>
  );
}

/**
 * «Немає» саме по собі нічого не каже (власник 17.09). Червоне лише те, без чого сайт працює
 * гірше, ніж має; вимкнена свідомо можливість і необов'язковий ключ ідуть тихо й підписані.
 */
function ConfigValue({ item }: { item: ConfigItem }) {
  if (item.state === "value") return <span className="font-mono text-xs break-all">{item.value}</span>;
  if (item.state === "set") return <span className="text-xs font-semibold text-ink">Set</span>;
  if (item.need === "unused") return <span className="text-xs text-ink-muted">Not set, and not needed</span>;
  if (item.need === "optional") return <span className="text-xs text-ink-muted">Not set, optional</span>;
  return <span className="text-xs font-semibold text-danger">Missing, needed</span>;
}

function EngineKeys({ keys, now }: { keys: EngineKeyReport[] | null; now: number }) {
  const missing = keys?.filter((k) => k.missingIn > 0) ?? null;
  if (missing !== null && missing.length === 0) {
    return (
      <p className="text-sm text-ink-muted" data-engine-keys="none">
        Every engine key the scoring engine asked for was there: no source result says &ldquo;not configured&rdquo;.
        Nothing to do.
      </p>
    );
  }
  return (
    <div className={BOARD}>
      <table className={`${TABLE} min-w-[520px]`} data-table="engine-keys">
        <caption className="px-3 pt-2.5 text-left text-xs text-ink-muted">
          Set on the VPS in /etc/nextcryptojob-engine.env. The site cannot read them; it only sees source results where the
          engine wrote &ldquo;not configured: KEY&rdquo;. Old results keep that gap until the weekly refresh.
        </caption>
        <thead>
          <tr>
            <th scope="col" className={TH_TIGHT}>Engine key</th>
            <th scope="col" className={`${TH_TIGHT} text-right`}>Results missing it</th>
            <th scope="col" className={TH_TIGHT}>Last seen missing</th>
          </tr>
        </thead>
        <tbody>
          {missing === null ? (
            <tr className={TR}>
              <td colSpan={3} className={`${TD_TIGHT} text-ink-muted`}>Could not read source results.</td>
            </tr>
          ) : (
            missing.map((k) => (
              <tr key={k.key} className={TR}>
                <th scope="row" className={`${TD_TIGHT} font-mono text-xs font-normal`}>{k.key}</th>
                <td className={cn(`${TD_TIGHT} text-right tabular-nums`, k.missingIn > 0 && "font-semibold text-danger")}>
                  {NUM.format(k.missingIn)}
                </td>
                <td className={TD_TIGHT}>
                  <Ago at={parseDbTime(k.lastSeen)} now={now} never="not seen" />
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

export default async function AdminSettingsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  if (!(await currentAdmin())) notFound();
  const params = await searchParams;
  const main = db();
  const [loaded, keys] = await Promise.all([
    loadSettings(main),
    engineKeyReport(main).catch((e: unknown) => {
      console.error(`settings page: engine keys: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }),
  ]);
  const env = appEnv() as unknown as Record<string, unknown>;
  const groups = workerConfig(env);
  const tables = codeTables();
  const now = new Date().getTime();
  const error = first(params.error);
  const done = first(params.done);
  const changed = Number(first(params.changed) ?? 0);

  return (
    <section className="mx-auto max-w-5xl px-[clamp(16px,4vw,56px)] pt-8 pb-20 sm:pt-12">
      <AdminNav current="/admin/settings" />
      <h1 className="display text-title">Settings</h1>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        Changes here apply without a deploy, within {SETTINGS_CACHE_TTL_MS / 1000} seconds on every server. Each change is
        written to the audit log. Everything below the forms needs a deploy or a secret and is shown read only.
      </p>

      {error && error in ERRORS ? (
        <p role="alert" className="mt-6 rounded-lg border border-destructive/50 bg-surface px-4 py-3 text-sm text-ink">
          {ERRORS[error as SettingsError]}
        </p>
      ) : null}
      {done === "saved" ? (
        <p role="status" className="mt-6 rounded-lg border border-ink bg-surface px-4 py-3 text-sm text-ink">
          {changed > 0 ? `Saved ${changed} ${changed === 1 ? "change" : "changes"}.` : "Nothing changed."}
        </p>
      ) : null}
      {loaded.error ? (
        <p role="alert" className="mt-6 rounded-lg border border-destructive/50 bg-surface px-4 py-3 text-sm text-ink">
          Showing defaults: could not read app_settings ({loaded.error}).
        </p>
      ) : null}

      <div className="mt-8 grid items-start gap-6 lg:grid-cols-2">
        <Panel id="signups" title="Sign-ups">
          <SignupsForm values={loaded.values} loaded={loaded} now={now} />
        </Panel>
        <Panel id="notice" title="Site notice">
          <NoticeForm values={loaded.values} loaded={loaded} now={now} />
        </Panel>
      </div>

      <h2 className="display mt-12 text-[1.75rem] leading-none">Worker configuration</h2>
      <p className="mt-2 max-w-prose text-sm text-ink-muted">
        Secrets and variables of the site Worker. Change them with <span className="font-mono text-xs">wrangler secret put</span> or
        in wrangler.jsonc, then deploy. Secret values are never shown.
      </p>
      <div className="mt-4 grid items-start gap-6 lg:grid-cols-2">
        {groups.map((g) => (
          <div key={g.title} className={BOARD}>
            <table className={TABLE} data-group={g.title}>
              <caption className="px-3 pt-2.5 text-left">
                <span className="font-display text-[1.0625rem] font-extrabold tracking-[0.02em] uppercase">{g.title}</span>
                {g.status ? (
                  <span className={cn("block text-xs", g.status.ok ? "text-ink-muted" : "font-semibold text-danger")}>{g.status.text}</span>
                ) : null}
              </caption>
              <thead>
                <tr>
                  <th scope="col" className={TH_TIGHT}>Name</th>
                  <th scope="col" className={TH_TIGHT}>Value</th>
                </tr>
              </thead>
              <tbody>
                {g.items.map((item) => (
                  <tr key={item.name} className={TR} data-config={item.name}>
                    <th scope="row" className={`${TD_TIGHT} align-top font-mono text-xs font-normal`}>{item.name}</th>
                    <td className={TD_TIGHT}>
                      <ConfigValue item={item} />
                      {item.note ? <div className="mt-0.5 text-xs text-ink-muted">{item.note}</div> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>

      <h2 className="display mt-12 text-[1.75rem] leading-none">Engine keys</h2>
      <div className="mt-4">
        <EngineKeys keys={keys} now={now} />
      </div>

      <details className="group mt-12" data-code-tables="">
        <summary className="inline-flex min-h-11 cursor-pointer items-center gap-2 rounded-lg border border-line bg-surface px-4 text-sm font-semibold text-ink hover:border-line-strong">
          <span className="group-open:hidden">Show the limits that live in code</span>
          <span className="hidden group-open:inline">Hide the limits that live in code</span>
          <span className="font-normal text-ink-muted">Quotas, seats, trial and prices: reference only, nothing to do here</span>
        </summary>
      <p className="mt-4 max-w-prose text-sm text-ink-muted">
        They are read in many places at once and are also stated on public pages and in the company terms, so they change
        with a code edit and a deploy, not here.
      </p>
      <div className="mt-4 grid gap-6">
        {tables.map((t) => (
          <div key={t.title} className={BOARD}>
            <table className={cn(TABLE, t.numeric && "min-w-[620px]")} data-code-table={t.title}>
              <caption className="px-3 pt-2.5 text-left">
                <span className="font-display text-[1.0625rem] font-extrabold tracking-[0.02em] uppercase">{t.title}</span>
                <span className="block font-mono text-xs text-ink-muted">{t.where}</span>
              </caption>
              <thead>
                <tr>
                  {t.head.map((h, i) => (
                    <th key={h} scope="col" className={cn(TH_TIGHT, i > 0 && t.numeric && "text-right")}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {t.rows.map((row) => (
                  <tr key={String(row[0])} className={TR}>
                    {row.map((cell, i) =>
                      i === 0 ? (
                        <th key={i} scope="row" className={`${TD_TIGHT} font-normal whitespace-nowrap`}>{cell}</th>
                      ) : (
                        <td key={i} className={cn(TD_TIGHT, t.numeric && "text-right tabular-nums")}>
                          {cell}
                        </td>
                      ),
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
      </details>
    </section>
  );
}
