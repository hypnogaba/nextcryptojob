import { Button } from "@/components/ui/button";
import { CopyButton } from "@/components/form/copy-button";
import { LINKS_MAX } from "@/lib/card/profile-prefs";
import type { ProfileView } from "@/lib/card/profile";
import {
  createApplyLinkAction,
  removeProofLinkAction,
  resetApplyLinkAction,
} from "./proof-actions";
import { ProofLinkForm } from "./proof-link-form";

// «Your proof profile» (docs/specs/2026-09-16-proof-profile-design.md, розділ 2): вигляд owner
// з lib/card/profile.ts. З 17.09 без редактора рядків: показуємо все, що зібрали.

const SMALL = "h-11 px-3 text-sm";

/**
 * Власник 17.09: «нам потрібно заховати всі пункти PDF-меню там, де людина це все бачить; людина
 * не мала би це все редагувати». Перемикачі Hide/Show на кожному рядку прибрано: PDF і картка
 * показують усі факти, які ми зібрали. Адреси гаманців лишились єдиним вибором, і він переїхав у
 * Settings (privacy), бо це про приватність, а не про вигляд PDF.
 */
function Line({ children }: { children: React.ReactNode }) {
  return <li className="flex items-start justify-between gap-3 text-ink">{children}</li>;
}

export function ProofPanel({
  view,
  publicUrl,
  applyUrl,
  pdfUrl,
}: {
  view: ProfileView;
  publicUrl: string;
  applyUrl: string | null;
  pdfUrl: string;
}) {
  return (
    <section id="proof" aria-labelledby="proof-panel-title" className="grid gap-6 rounded-xl border border-line bg-surface p-4 sm:p-6">
      <div className="grid gap-2">
        <h2 id="proof-panel-title" className="display text-xl">
          Your proof profile
        </h2>
        <p className="text-sm text-ink-muted">
          Use it instead of a CV. Everyone with your card link sees the facts without names or links. Your apply link and
          the PDF also show your links, your own words and how to reach you. Every fact we collected is in there; you do
          not have to pick the lines.
        </p>
      </div>

      <div className="grid gap-3">
        {applyUrl ? (
          <>
            <p className="break-all rounded-md border border-line bg-soft px-3 py-2 font-mono text-sm text-ink">{applyUrl}</p>
            <div className="flex flex-wrap gap-3">
              <Button asChild className="h-11 px-4">
                <a href={pdfUrl} download>
                  Download PDF
                </a>
              </Button>
              <CopyButton text={applyUrl} />
            </div>
            <form action={resetApplyLinkAction} className="flex flex-wrap items-center gap-3">
              <Button type="submit" variant="ghost" className={SMALL}>
                Reset apply link
              </Button>
              <span className="text-sm text-ink-muted">The old link will show only the public facts.</span>
            </form>
          </>
        ) : (
          <div className="flex flex-wrap gap-3">
            <form action={createApplyLinkAction}>
              <Button type="submit" className="h-11 px-4">
                Get my apply link
              </Button>
            </form>
            <Button asChild className="h-11 px-4">
              <a href={pdfUrl} download>
                Download PDF
              </a>
            </Button>
          </div>
        )}
        {/* Власник 16.09, p1: «не можу перевірити, як це бачать інші». Та сама сторінка картки без
            дій власника (?as=public), як її бачить будь-хто з посиланням. */}
        <Button asChild variant="outline" className="h-11 w-fit px-4">
          <a href={`${publicUrl}?as=public`} target="_blank" rel="noopener">
            See what others see
          </a>
        </Button>
      </div>

      {view.groups.map((g) => (
        <div key={g.key} className="grid gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">
            {g.title}
            {g.link ? <span className="ml-2 normal-case tracking-normal">{g.link.label}</span> : null}
          </h3>
          <ul className="grid gap-2">
            {g.lines.map((l) => (
              <Line key={l.id}>{l.text}</Line>
            ))}
          </ul>
        </div>
      ))}

      {view.words.length ? (
        <div className="grid gap-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Your words</h3>
          <ul className="grid gap-2">
            {view.words.map((w) => (
              <Line key={w.id}>
                <span>
                  <span className="text-ink-muted">{w.label}: </span>
                  {w.text}
                </span>
              </Line>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="grid gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-ink-muted">Your links</h3>
        {view.links.length ? (
          <ul className="grid gap-2">
            {view.links.map((l, i) => (
              <li key={i} className="flex items-start justify-between gap-3">
                <span className="min-w-0 break-words text-ink">
                  {l.label} <span className="text-sm text-ink-muted">{l.url}</span>
                </span>
                <form action={removeProofLinkAction} className="shrink-0">
                  <input type="hidden" name="index" value={i} />
                  <Button type="submit" variant="outline" className={SMALL}>
                    Remove
                  </Button>
                </form>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">
            Your portfolio, articles, talks or projects. Each link adds to your score (up to {LINKS_MAX}). We do not check
            them, and your card says they were added by you.
          </p>
        )}
        {view.links.length < LINKS_MAX ? <ProofLinkForm /> : null}
      </div>
    </section>
  );
}
