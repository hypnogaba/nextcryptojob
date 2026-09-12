import Link from "next/link";
import type { Identity } from "@/lib/identity/store";

/**
 * Нагадування підтвердити X чи GitHub: неперевірені ми не рахуємо, і картку
 * без них не створити. Людина, що пропустила X, теж його бачить.
 */
export function VerifyPrompt({ x, github }: { x: Identity | null; github: Identity | null }) {
  const items: { key: string; text: string; href: string; action: string }[] = [];
  if (!x) {
    items.push({
      key: "x",
      text: "Add and verify your X. Most roles are scored from X, and we count it only after you check your code.",
      href: "/welcome?step=x",
      action: "Verify X",
    });
  } else if (!x.verifiedAt) {
    items.push({
      key: "x",
      text: `Your X @${x.value} is not verified yet, so we do not count it. Add your code to your bio or a post, then press Check.`,
      href: "/welcome?step=x",
      action: "Verify X",
    });
  }
  if (github && !github.verifiedAt) {
    items.push({
      key: "github",
      text: `Your GitHub ${github.value} is not verified yet, so we do not count it.`,
      href: "/welcome?step=sources",
      action: "Verify GitHub",
    });
  }
  if (items.length === 0) return null;
  return (
    <div className="grid gap-3 rounded-xl border border-brand bg-brand-soft p-4 sm:p-5">
      {items.map((i) => (
        <div key={i.key} className="grid gap-1">
          <p className="text-sm text-ink">{i.text}</p>
          <Link href={i.href} className="inline-flex min-h-11 w-fit items-center text-sm font-medium text-brand underline underline-offset-4">
            {i.action}
          </Link>
        </div>
      ))}
    </div>
  );
}
