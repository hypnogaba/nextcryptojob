"use client";

import Link from "next/link";
import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { SubmitButton } from "@/components/form/submit-button";
import { SwitchButton } from "@/components/form/switch-button";
import { cn } from "@/lib/utils";
import { setContactModeAction, setVisibilityAction, type SettingsState } from "./actions";

// Те, що віддає lib/crm/project.ts: ролі й бали, мережі й роки ончейн, які джерела підключено, де й за скільки.
// Власник 14.09 (C4): поки «Show my Telegram directly» увімкнено, компанія бачить не лише нік, а й
// самі посилання (X, GitHub, YouTube, сайт) і адреси гаманців (lib/crm/project.ts, linksOf).
const SEE = [
  "Your roles, scores and levels",
  "Which chains you use and for how long",
  "Which sources you connected, as a checkmark",
  "Remote or a city, and the pay you want",
  "Your Telegram, X, GitHub, YouTube, website and wallet addresses, if “Show my Telegram directly” is on",
];
const NEVER = ["Your email, unless you say yes to a request"];

const ROW = "flex items-center justify-between gap-4 rounded-xl border border-line bg-surface p-3 sm:p-4";
const STATE = "flex items-start gap-2 text-lg leading-snug font-semibold text-ink";
const DOT = "mt-2 inline-block size-3 shrink-0 rounded-full";

export type ContactProps = { mode: "approval" | "direct"; telegramHandle: string | null };

/**
 * «Show me to companies» окремою панеллю з власним тлом (власник 14.09: натиснув і не побачив
 * змін). Два перемикачі зі станом словами: видимість і «Show my Telegram directly» (з 14.09 обидва
 * увімкнені за замовчуванням для нових людей). Під ними що компанії бачать і чого ніколи,
 * і рядок «Saved» після натискання.
 */
export function VisibilityForm({
  visible,
  canTurnOn,
  contact,
}: {
  visible: boolean;
  canTurnOn: boolean;
  contact: ContactProps;
}) {
  const [state, action] = useActionState(setVisibilityAction, {} as SettingsState);
  const locked = !visible && !canTurnOn;
  return (
    <section
      aria-labelledby="companies-title"
      data-visible={visible ? "on" : "off"}
      className={cn(
        "grid gap-5 rounded-xl border-2 p-4 transition-colors sm:p-6",
        visible ? "border-brand bg-brand-soft" : "border-ink bg-wash",
      )}
    >
      <div className="grid gap-1">
        <h2 id="companies-title" className="display text-[1.75rem] leading-none">
          Show me to companies
        </h2>
        <p className="text-sm text-ink-muted">
          Companies that pay for NextCryptoJob search for candidates by role and score. These two switches decide if you
          are in that search and how they can reach you.
        </p>
      </div>

      <form action={action} className="grid gap-3">
        {/* Кнопка шле протилежне до поточного: одне натискання = одна зміна. */}
        <input type="hidden" name="visible" value={visible ? "off" : "on"} />
        <div className={ROW}>
          <div className="grid gap-0.5">
            <p id="visibility-label" className={STATE}>
              <span aria-hidden className={cn(DOT, visible ? "bg-brand" : "bg-line-strong")} />
              {visible ? "You are visible to companies" : "You are hidden from companies"}
            </p>
            <p id="visibility-help" className="text-sm text-ink-muted">
              {visible
                ? "Companies with access can find you in their search. Turn it off and you leave their search at once."
                : "No company can find you. Your score and daily jobs work the same either way."}
            </p>
          </div>
          <SwitchButton
            checked={visible}
            disabled={locked}
            labelledBy="visibility-label"
            describedBy="visibility-help visibility-see"
          />
        </div>

        {locked ? (
          <p className="text-sm text-ink">
            You need a score first.{" "}
            <Link href="/welcome" className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
              Finish setting up
            </Link>
          </p>
        ) : (
          <SubmitButton
            variant={visible ? "outline" : "default"}
            pendingLabel="Saving..."
            className="h-11 w-full px-5 text-base sm:w-fit"
          >
            {visible ? "Hide me from companies" : "Show me to companies"}
          </SubmitButton>
        )}
        <FormMessageLine message={state.message} />
      </form>

      <ContactSwitch {...contact} visible={visible} />

      <div id="visibility-see" className="grid gap-4 text-sm sm:grid-cols-2">
        <div className="grid gap-1.5">
          <p className="font-semibold text-ink">When you are visible, companies see</p>
          <ul className="grid gap-1 text-ink">
            {SEE.map((t) => (
              <li key={t}>+ {t}</li>
            ))}
          </ul>
        </div>
        <div className="grid gap-1.5">
          <p className="font-semibold text-ink">They never see</p>
          <ul className="grid gap-1 text-ink">
            {NEVER.map((t) => (
              <li key={t}>&minus; {t}</li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/** Стан «Show my Telegram directly» словами: увімкнено з ніком, увімкнено без ніка, вимкнено. */
export function contactStateText(mode: ContactProps["mode"], handle: string | null): { title: string; help: string } {
  if (mode === "approval") {
    return {
      title: "Companies ask you first",
      help: "A company sends you an intro request. It sees your Telegram only after you say yes.",
    };
  }
  if (handle) {
    return {
      title: `Your Telegram ${handle} is shown`,
      help: "Every company that can see you also sees your handle and can message you directly. You are told who viewed it.",
    };
  }
  return {
    title: "Your Telegram will be shown",
    help:
      "You have no Telegram username yet, so for now companies send you an intro request first. " +
      "We never show your email without your yes.",
  };
}

function ContactSwitch({ mode, telegramHandle, visible }: ContactProps & { visible: boolean }) {
  const [state, action] = useActionState(setContactModeAction, {} as SettingsState);
  const direct = mode === "direct";
  const handle = telegramHandle ? `@${telegramHandle.trim().replace(/^@+/, "")}` : null;
  const words = contactStateText(mode, handle && handle !== "@" ? handle : null);
  return (
    <form id="contact" action={action} className="grid gap-3" data-contact-mode={mode}>
      {/* Вимкнення повертає до «after approval». */}
      <input type="hidden" name="mode" value={direct ? "approval" : "direct"} />
      <div className={ROW}>
        <div className="grid gap-0.5">
          <p id="contact-name" className="text-sm font-semibold text-ink-muted">Show my Telegram directly</p>
          <p id="contact-label" className={STATE}>
            <span aria-hidden className={cn(DOT, direct ? "bg-brand" : "bg-line-strong")} />
            {words.title}
          </p>
          <p id="contact-help" className="text-sm text-ink-muted">
            {words.help}
            {visible ? "" : " This counts only while you are visible."}
          </p>
        </div>
        <SwitchButton checked={direct} labelledBy="contact-name" describedBy="contact-label contact-help" />
      </div>
      <FormMessageLine message={state.message} />
    </form>
  );
}
