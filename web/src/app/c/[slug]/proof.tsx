import type { ProfileLink } from "@/lib/card/profile-prefs";
import type { ProfileView } from "@/lib/card/profile";

// Блок Proof під карткою. Публічний вигляд не має посилань і контакту (lib/card/profile.ts);
// тут лише показуємо те, що прийшло.

const LINK =
  "font-semibold text-ink underline decoration-line-strong decoration-2 underline-offset-4 hover:decoration-ink break-words";

function Out({ link, rel = "noopener noreferrer" }: { link: ProfileLink; rel?: string }) {
  return (
    <a href={link.url} target="_blank" rel={rel} className={LINK}>
      {link.label}
    </a>
  );
}

export function Proof({ view }: { view: ProfileView }) {
  const full = view.mode !== "public";
  const hasContact = view.contact.telegram || view.contact.email;
  if (!view.groups.length && !full) return null;
  return (
    <section aria-labelledby="proof-title" className="grid gap-5 border-t border-line pt-6" data-proof={view.mode}>
      <div className="grid gap-1">
        <h2 id="proof-title" className="display text-xl">
          Proof
        </h2>
        <p className="text-sm text-ink-muted">
          {full
            ? "Public record behind the score, with links to check it."
            : "Public record behind the score. Names, links and contacts are shared only by the card owner."}
        </p>
      </div>

      {view.roles.length || view.place ? (
        <p className="text-ink">
          {view.roles.join(", ")}
          {view.place ? <span className="text-ink-muted"> · {view.place}</span> : null}
        </p>
      ) : null}

      {full && hasContact ? (
        <p className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          <span className="text-ink-muted">Contact:</span>
          {view.contact.telegram ? <Out link={view.contact.telegram} /> : null}
          {view.contact.email ? (
            <a href={`mailto:${view.contact.email}`} className={LINK}>
              {view.contact.email}
            </a>
          ) : null}
        </p>
      ) : null}

      {view.groups.map((g) => (
        <div key={g.key} className="grid gap-2">
          <h3 className="flex flex-wrap items-baseline gap-x-3 text-sm font-semibold uppercase tracking-wide text-ink-muted">
            {g.title}
            {g.link ? (
              <span className="text-sm normal-case tracking-normal">
                <Out link={g.link} />
              </span>
            ) : null}
          </h3>
          <ul className="grid gap-1 text-ink">
            {g.lines.map((l) => (
              <li key={l.id}>{l.text}</li>
            ))}
          </ul>
        </div>
      ))}

      {full && view.wallets.length ? (
        <div className="grid gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Wallets</h3>
          <ul className="grid gap-1 font-mono text-sm break-all text-ink">
            {view.wallets.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {view.words.map((w) => (
        <div key={w.id} className="grid gap-1">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">{w.label}</h3>
          <p className="whitespace-pre-line text-ink">{w.text}</p>
        </div>
      ))}

      {view.links.length ? (
        <div className="grid gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Links added by the owner</h3>
          <ul className="grid gap-1">
            {view.links.map((l, i) => (
              <li key={i}>
                <Out link={l} rel="nofollow ugc noopener noreferrer" />
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
