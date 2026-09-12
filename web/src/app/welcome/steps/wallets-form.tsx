"use client";

import { useActionState, useMemo, useState } from "react";
import { FormMessageLine } from "@/components/form/form-message";
import { HINT, LABEL, TEXTAREA } from "@/components/form/styles";
import { SubmitButton } from "@/components/form/submit-button";
import { MAX_WALLETS, parseWallets, type WalletKind } from "@/lib/identity/wallets";
import { cn } from "@/lib/utils";
import { saveWalletsAction } from "../actions/wallets";
import type { StepState } from "../flow";

const CHIP: Record<WalletKind, { label: string; className: string }> = {
  evm: { label: "EVM", className: "border border-line-strong text-ink" },
  solana: { label: "Solana", className: "border border-brand bg-brand-soft text-ink" },
};

export function WalletsForm({ initial, editing }: { initial: string; editing: boolean }) {
  const [state, action] = useActionState(saveWalletsAction, {} as StepState);
  const [text, setText] = useState(initial);
  // Той самий розбір, що на сервері: людина бачить тип кожної адреси ще до збереження.
  const parsed = useMemo(() => parseWallets(text), [text]);
  const serverErrors = state.errors ?? {};
  const inputs = text.split(/[\s,;]+/).filter(Boolean);

  return (
    <form action={action} className="grid gap-4">
      <label htmlFor="wallets" className={LABEL}>
        Wallet addresses
      </label>
      <textarea
        id="wallets"
        name="wallets"
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        autoCapitalize="none"
        autoComplete="off"
        placeholder={"0x1234...\nSo1ana..."}
        aria-describedby="wallets-hint"
        className={cn(TEXTAREA, "font-mono text-sm")}
      />
      <p id="wallets-hint" className={HINT}>
        Paste one or more EVM or Solana addresses, up to {MAX_WALLETS}. We only read public activity. You never sign
        anything here.
      </p>

      {inputs.length > 0 ? (
        <ul className="grid gap-2" aria-label="Addresses we found">
          {parsed.wallets.map((w) => {
            const original = inputs.find((i) => (w.kind === "evm" ? i.toLowerCase() === w.value : i === w.value));
            const error = original ? serverErrors[original] : undefined;
            return (
              <li key={`${w.kind}:${w.value}`} className="grid gap-1 rounded-lg border border-line bg-surface px-3 py-2">
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[0.65rem] tracking-wider uppercase",
                      CHIP[w.kind].className,
                    )}
                  >
                    {CHIP[w.kind].label}
                  </span>
                  <span className="min-w-0 font-mono text-xs break-all text-ink">{w.value}</span>
                </span>
                {error ? (
                  <span role="alert" className="text-sm text-destructive">
                    {error}
                  </span>
                ) : null}
              </li>
            );
          })}
          {parsed.errors.map((e) => (
            <li
              key={`err:${e.input}`}
              className="grid gap-1 rounded-lg border border-destructive/50 bg-surface px-3 py-2"
            >
              <span className="min-w-0 font-mono text-xs break-all text-ink">{e.input}</span>
              <span role="alert" className="text-sm text-destructive">
                {e.error}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      <FormMessageLine message={state.message} />
      <SubmitButton pendingLabel="Saving..." className="h-11 text-base" disabled={parsed.errors.length > 0}>
        {inputs.length === 0 ? (editing ? "Save without wallets" : "Skip for now") : editing ? "Save" : "Continue"}
      </SubmitButton>
    </form>
  );
}
