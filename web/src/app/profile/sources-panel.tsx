import Link from "next/link";
import type { Identity } from "@/lib/identity/store";
import { shortAddress } from "@/lib/identity/wallets";
import { cn } from "@/lib/utils";

const GROUPS: { title: string; kinds: Identity["kind"][]; step: string }[] = [
  { title: "X", kinds: ["x"], step: "x" },
  { title: "Wallets", kinds: ["evm", "solana"], step: "wallets" },
  { title: "Other sources", kinds: ["github", "youtube", "site", "sherlock"], step: "sources" },
];

const KIND_LABEL: Record<Identity["kind"], string> = {
  x: "X",
  github: "GitHub",
  youtube: "YouTube",
  site: "Website",
  evm: "EVM",
  solana: "Solana",
  sherlock: "Sherlock",
};

function shown(i: Identity): string {
  switch (i.kind) {
    case "x":
      return `@${i.value}`;
    case "github":
      return `github.com/${i.value}`;
    case "site":
      return i.value.replace(/^https:\/\//, "");
    case "evm":
    case "solana":
      return shortAddress(i.value);
    default:
      return i.value;
  }
}

function Badge({ identity }: { identity: Identity }) {
  const verified = identity.verifiedAt !== null;
  const text = verified
    ? "Verified"
    : identity.kind === "sherlock"
      ? "Checked when we score"
      : "Not verified";
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm border px-1.5 py-0.5 text-xs font-semibold",
        verified ? "border-ink text-ink" : "border-line text-ink-muted",
      )}
    >
      {text}
    </span>
  );
}

/** Підключені джерела з позначками перевірки й посиланням на потрібний крок анкети. */
export function SourcesPanel({ identities }: { identities: Identity[] }) {
  return (
    <section aria-labelledby="sources-title" className="grid gap-4 rounded-xl border border-line bg-surface p-4 sm:p-6">
      <h2 id="sources-title" className="display text-[2rem] leading-none">
        Sources
      </h2>
      {GROUPS.map((g) => {
        const items = identities.filter((i) => g.kinds.includes(i.kind));
        return (
          <div key={g.title} className="grid gap-2 border-t border-line pt-4 first-of-type:border-t-0 first-of-type:pt-0">
            <div className="flex items-center justify-between gap-3">
              <h3 className="font-sans text-sm font-semibold text-ink">{g.title}</h3>
              <Link
                href={`/welcome?step=${g.step}`}
                className="-mr-2 inline-flex min-h-11 items-center px-2 text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand"
              >
                {items.length > 0 ? "Edit" : "Add"}
              </Link>
            </div>
            {items.length === 0 ? (
              <p className="text-sm text-ink-muted">Not connected.</p>
            ) : (
              <ul className="grid gap-2">
                {items.map((i) => (
                  <li key={i.id} className="flex items-center justify-between gap-3">
                    <span className="min-w-0 truncate text-sm text-ink">
                      <span className="text-ink-muted">{KIND_LABEL[i.kind]}</span>{" "}
                      <span className={cn(i.kind === "evm" || i.kind === "solana" ? "font-mono text-xs" : "")}>
                        {shown(i)}
                      </span>
                    </span>
                    <Badge identity={i} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </section>
  );
}
