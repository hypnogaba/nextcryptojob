"use client";

import Link from "next/link";
import { useActionState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { HINT } from "@/components/form/styles";
import { SwitchButton } from "@/components/form/switch-button";
import { setVisibilityAction, type SettingsState } from "./actions";

export function VisibilityForm({ visible, canTurnOn }: { visible: boolean; canTurnOn: boolean }) {
  const [state, action] = useActionState(setVisibilityAction, {} as SettingsState);
  const locked = !visible && !canTurnOn;
  return (
    <form action={action} className="grid gap-3">
      {/* Кнопка шле протилежне до поточного: одне натискання = одна зміна. */}
      <input type="hidden" name="visible" value={visible ? "off" : "on"} />
      <div className="flex items-start justify-between gap-4">
        <div className="grid gap-1">
          <p id="visibility-label" className="text-base font-medium text-ink">
            Show me to companies
          </p>
          <p id="visibility-help" className={HINT}>
            {visible ? "On. Companies with access can find you." : "Off. Companies cannot find you."}
          </p>
        </div>
        <SwitchButton
          checked={visible}
          disabled={locked}
          labelledBy="visibility-label"
          describedBy="visibility-help visibility-what"
        />
      </div>
      <p id="visibility-what" className={HINT}>
        While this is off, companies cannot find you. When it is on, companies with access see your scores, roles,
        level, chains and badges. They never see your wallets, email or handles. You can turn it off at any time, and
        you disappear from their search at once.
      </p>
      {locked ? (
        <p className={HINT}>
          You need a score first.{" "}
          <Link href="/welcome" className="font-medium text-brand underline underline-offset-4">
            Finish setting up
          </Link>
        </p>
      ) : null}
      <FormMessageLine message={state.message} />
    </form>
  );
}
