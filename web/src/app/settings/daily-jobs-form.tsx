"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { ERROR, FIELD, HINT, LABEL } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { detectTimezoneAction, saveDailyJobsAction, type SettingsState } from "./actions";

type Props = {
  email: string | null;
  telegramLinked: boolean;
  channel: "email" | "telegram";
  hour: number;
  timezone: string | null;
  paused: boolean;
  zones: readonly string[];
  /** Дія форми: за замовчуванням «Save» налаштувань; анкета (/welcome) дає свою. */
  action?: (prev: SettingsState, form: FormData) => Promise<SettingsState>;
  /** Показувати «Pause daily jobs» (у налаштуваннях так, в анкеті ні). */
  showPause?: boolean;
  submitLabel?: string;
};

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourLabel = (h: number) => `${String(h).padStart(2, "0")}:00`;

/** Той самий пояс під іншою назвою (Europe/Kyiv і Europe/Kiev): порівнюємо так, як бачить браузер. */
function matchZone(detected: string, zones: readonly string[]): string | null {
  if (zones.includes(detected)) return detected;
  const canon = (z: string) => {
    try {
      return new Intl.DateTimeFormat("en-US", { timeZone: z }).resolvedOptions().timeZone;
    } catch {
      return null;
    }
  };
  const target = canon(detected);
  if (!target) return null;
  return zones.find((z) => canon(z) === target) ?? null;
}

const RADIO_ROW =
  "flex min-h-12 cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-3 " +
  "has-[:checked]:border-ink has-[:checked]:shadow-[inset_0_0_0_1px_var(--ink)] " +
  "has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60";

export function DailyJobsForm({
  email,
  telegramLinked,
  channel,
  hour,
  timezone,
  paused,
  zones,
  action: submit = saveDailyJobsAction,
  showPause = true,
  submitLabel = "Save",
}: Props) {
  const [state, action] = useActionState(submit, {} as SettingsState);
  const zoneRef = useRef<HTMLSelectElement>(null);
  const [detected, setDetected] = useState(false);

  // Перший візит: пояс ще не збережено, беремо з браузера й одразу пишемо.
  useEffect(() => {
    if (timezone) return;
    const fromDevice = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const match = fromDevice ? matchZone(fromDevice, zones) : null;
    if (!match || !zoneRef.current) return;
    // Прямо в поле: HTML з сервера лишається тим самим, без розбіжності гідратації.
    zoneRef.current.value = match;
    detectTimezoneAction(match)
      .catch(() => {
        // Не вийшло записати: людина збереже пояс сама кнопкою Save.
      })
      .finally(() => setDetected(true));
  }, [timezone, zones]);

  const errors = state.errors ?? {};
  // Після дії React скидає форму до значень за замовчуванням, а <select> при цьому
  // бере варіант із першого показу, навіть керований. Ключ зі збережених значень
  // перебудовує форму, щойно сервер віддав нові, тож видно саме збережене.
  const saved = `${channel}|${hour}|${timezone ?? ""}|${paused ? 1 : 0}`;
  return (
    <form key={saved} action={action} className="grid gap-5">
      <fieldset className="grid gap-2" aria-describedby={errors.channel ? "channel-error" : undefined}>
        <legend className={`${LABEL} mb-2`}>Send my jobs by</legend>
        <label className={RADIO_ROW}>
          <input
            type="radio"
            name="channel"
            value="email"
            defaultChecked={channel === "email"}
            disabled={!email}
            className="mt-1 size-5 shrink-0 accent-[var(--brand)]"
          />
          <span className="grid gap-0.5">
            <span className="text-base text-ink">Email</span>
            <span className={HINT}>{email ?? "Add an email above to use this."}</span>
          </span>
        </label>
        <label className={RADIO_ROW}>
          <input
            type="radio"
            name="channel"
            value="telegram"
            defaultChecked={channel === "telegram"}
            disabled={!telegramLinked}
            aria-describedby="telegram-hint"
            className="mt-1 size-5 shrink-0 accent-[var(--brand)]"
          />
          <span className="grid gap-0.5">
            <span className="text-base text-ink">Telegram</span>
            <span id="telegram-hint" className={HINT}>
              {telegramLinked ? "A message from our bot." : "Connect Telegram on your account page to use this."}
            </span>
          </span>
        </label>
        {errors.channel ? (
          <p id="channel-error" role="alert" className={ERROR}>
            {errors.channel}
          </p>
        ) : null}
      </fieldset>

      <div className="grid gap-4 sm:grid-cols-[10rem_1fr]">
        <div className="grid gap-1.5">
          <label htmlFor="hour" className={LABEL}>
            Time
          </label>
          <select
            id="hour"
            name="hour"
            defaultValue={String(hour)}
            aria-invalid={errors.hour ? true : undefined}
            aria-describedby={errors.hour ? "hour-error" : undefined}
            className={FIELD}
          >
            {HOURS.map((h) => (
              <option key={h} value={h}>
                {hourLabel(h)}
              </option>
            ))}
          </select>
          {errors.hour ? (
            <p id="hour-error" role="alert" className={ERROR}>
              {errors.hour}
            </p>
          ) : null}
        </div>
        <div className="grid gap-1.5">
          <label htmlFor="timezone" className={LABEL}>
            Time zone
          </label>
          <select
            id="timezone"
            name="timezone"
            ref={zoneRef}
            defaultValue={timezone ?? "UTC"}
            onChange={() => setDetected(false)}
            aria-invalid={errors.timezone ? true : undefined}
            aria-describedby={errors.timezone ? "timezone-error" : "timezone-hint"}
            className={FIELD}
          >
            {zones.map((z) => (
              <option key={z} value={z}>
                {z.replaceAll("_", " ")}
              </option>
            ))}
          </select>
          {errors.timezone ? (
            <p id="timezone-error" role="alert" className={ERROR}>
              {errors.timezone}
            </p>
          ) : (
            <p id="timezone-hint" className={HINT}>
              {detected ? "We picked the time zone of this device." : "The hour is in this time zone."}
            </p>
          )}
        </div>
      </div>

      {showPause ? (
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line bg-surface p-3">
          <input
            type="checkbox"
            name="paused"
            value="on"
            defaultChecked={paused}
            aria-describedby="paused-hint"
            className="mt-1 size-5 shrink-0 accent-[var(--brand)]"
          />
          <span className="grid gap-0.5">
            <span className="text-base text-ink">Pause daily jobs</span>
            <span id="paused-hint" className={HINT}>
              We keep your choices and send nothing until you untick this.
            </span>
          </span>
        </label>
      ) : null}

      <div className="grid gap-2">
        <SubmitButton pendingLabel="Saving..." className="h-11 w-full px-5 text-base sm:w-fit">
          {submitLabel}
        </SubmitButton>
        <FormMessageLine message={state.message} />
      </div>
    </form>
  );
}
