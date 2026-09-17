import { Button } from "@/components/ui/button";
import { HINT } from "@/components/form/styles";
import { loadPrefs } from "@/lib/card/profile-prefs";
import { db } from "@/lib/db";
import { listIdentities } from "@/lib/identity/store";
import { setProofWalletAction } from "../profile/proof-actions";

/**
 * Адреси гаманців у посиланні для подачі й у PDF (власник 17.09): єдиний вибір, що лишився від
 * старого «PDF-меню» на /profile. Він про приватність, а не про вигляд PDF, тож живе тут, поруч
 * з іншою приватністю. Людини без гаманців це не торкається, і блок їй не показуємо.
 */
/** Стан для блока: скільки гаманців людина додала і чи показувати їхні адреси. */
export type WalletVisibilityState = { wallets: number; showWallet: boolean };

/**
 * Читаємо в сторінці (вона вже async), а не в самому блоці: сторінку малює renderToStaticMarkup у
 * тестах, і async-компонент усередині готового дерева «зависає» на Suspense.
 */
export async function loadWalletVisibility(userId: string): Promise<WalletVisibilityState | null> {
  const d = db();
  const [identities, prefs] = await Promise.all([
    listIdentities(d, userId).catch(() => []),
    loadPrefs(d, userId).catch(() => null),
  ]);
  if (!prefs) return null;
  return { wallets: identities.filter((i) => i.kind === "evm" || i.kind === "solana").length, showWallet: prefs.showWallet };
}

export function WalletVisibility({ state }: { state: WalletVisibilityState | null }) {
  if (!state || state.wallets === 0) return null;
  const on = state.showWallet;

  return (
    <section id="wallets" aria-labelledby="wallets-title" className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:p-6">
      <div className="grid gap-1">
        <h2 id="wallets-title" className="font-display text-xl leading-tight font-semibold tracking-[-0.01em]">
          Wallet addresses
        </h2>
        <p className={HINT}>
          Your onchain history always counts for your score. This is only about the addresses themselves: whether
          someone with your apply link or your PDF can read them.
        </p>
      </div>
      <form action={setProofWalletAction} className="flex flex-wrap items-center justify-between gap-3">
        <input type="hidden" name="on" value={on ? "0" : "1"} />
        <input type="hidden" name="back" value="settings" />
        <span className="text-sm text-ink">
          In your apply link and PDF: <strong>{on ? "shown" : "hidden"}</strong>
        </span>
        <Button type="submit" variant="outline" size="lg">
          {on ? "Hide addresses" : "Show addresses"}
        </Button>
      </form>
    </section>
  );
}
