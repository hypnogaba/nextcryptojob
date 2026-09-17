"use client";

import { ArrowUpRight, X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { myProofAction, type ProofState } from "./apply-actions";

/**
 * «Apply» з вибором (власник 17.09): «коли натискаєш податися, мені мало би пропонувати два
 * варіанти: податися просто на сайті чи податися з нашим PDF». Раніше кнопка вела прямо на сайт
 * компанії, і про PDF людина дізнавалась лише на сторінці вакансії, та й то тільки з карткою.
 *
 * Стан картки питаємо на відкритті вікна (apply-actions.ts), не пропсами: картка вакансії
 * лишається серверною й однаковою для всіх, а про PDF кажемо за свіжим станом цієї людини.
 * Клік по самій картці веде на сторінку вакансії (job-card.tsx overlay), тож ця кнопка, як і
 * «Save», лежить своїм шаром поверх нього.
 */
export function ApplyChoice({
  href,
  label,
  newTab,
  rel,
  company,
  compact,
}: {
  href: string;
  label: string;
  newTab: boolean;
  rel: string | null;
  company: string;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [proof, setProof] = useState<ProofState | null>(null);
  const [got, setGot] = useState(false);
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open || proof) return;
    let stopped = false;
    void myProofAction()
      .then((res) => {
        if (!stopped) setProof(res);
      })
      .catch(() => {
        if (!stopped) setProof({ state: "no-card" });
      });
    return () => {
      stopped = true;
    };
  }, [open, proof]);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const site = (
    <a
      href={href}
      {...(newTab ? { target: "_blank", rel: rel ?? undefined } : {})}
      onClick={() => setOpen(false)}
      className="grid gap-1 rounded-2xl border-[1.5px] border-ink bg-ink px-4 py-3.5 text-left text-ground hover:bg-ink/90"
    >
      <span className="flex items-center gap-1.5 font-semibold">
        Apply on the company site
        {newTab ? <ArrowUpRight aria-hidden className="size-4" /> : null}
      </span>
      <span className="text-sm text-ground/75">You apply directly with {company}. Their form, their questions.</span>
    </a>
  );

  return (
    <>
      {/* Тригер це справжнє посилання на подачу, а не кнопка: без JS (і для пошуковика, і в
          новій вкладці через Cmd-клік) він веде прямо на сайт компанії, як і до 17.09. Простий
          клік ми перехоплюємо й показуємо вибір. */}
      <Button
        asChild
        size={compact ? "default" : "lg"}
        variant={compact ? "outline" : "default"}
        className="w-full sm:w-auto"
      >
        <a
          href={href}
          {...(newTab ? { target: "_blank", rel: rel ?? undefined } : rel ? { rel } : {})}
          aria-haspopup="dialog"
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
            e.preventDefault();
            setOpen(true);
          }}
        >
          {label}
          {newTab ? <ArrowUpRight aria-hidden="true" data-icon="inline-end" /> : null}
        </a>
      </Button>

      {open ? (
        <div className="fixed inset-0 z-50 grid place-items-center p-4">
          <button
            type="button"
            aria-label="Close"
            tabIndex={-1}
            onClick={() => setOpen(false)}
            className="absolute inset-0 cursor-default bg-ink/35"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="apply-choice-title"
            className="relative grid w-full max-w-[28rem] gap-4 rounded-3xl border border-line bg-surface p-5 shadow-xl sm:p-6"
          >
            <div className="flex items-start justify-between gap-4">
              <h2 id="apply-choice-title" className="font-display text-xl leading-tight font-semibold tracking-[-0.01em] text-ink">
                How do you want to apply?
              </h2>
              <button
                ref={closeRef}
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-ink-muted hover:bg-soft hover:text-ink"
              >
                <X aria-hidden className="size-4" />
              </button>
            </div>

            {site}

            {proof === null ? (
              <p className="text-sm text-ink-muted">Checking your card…</p>
            ) : proof.state === "card" ? (
              <div className="grid gap-2 rounded-2xl border border-line bg-soft px-4 py-3.5">
                <p className="font-semibold text-ink">Apply with your one-pager</p>
                <p className="text-sm text-ink-muted">
                  One page built from your public work: your score, your sources and the facts behind them. Attach it
                  where the form asks for a CV.
                </p>
                <div className="flex flex-wrap items-center gap-3">
                  <Button asChild className="h-11 px-4">
                    <a href={proof.pdf} download onClick={() => setGot(true)}>
                      Download my PDF
                    </a>
                  </Button>
                  {got ? (
                    <a
                      href={href}
                      {...(newTab ? { target: "_blank", rel: rel ?? undefined } : {})}
                      onClick={() => setOpen(false)}
                      className="text-sm font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand"
                    >
                      Now open the company site
                    </a>
                  ) : null}
                </div>
              </div>
            ) : proof.state === "no-card" ? (
              <div className="grid gap-2 rounded-2xl border border-line bg-soft px-4 py-3.5">
                <p className="font-semibold text-ink">Apply with a one-pager instead of a CV</p>
                <p className="text-sm text-ink-muted">
                  Create your card and we build a one-page PDF from your public work: your score and the facts behind
                  it. It takes a minute.
                </p>
                <Button asChild variant="outline" className="h-11 w-fit px-4">
                  <Link href="/profile#proof" onClick={() => setOpen(false)}>
                    Create my card
                  </Link>
                </Button>
              </div>
            ) : (
              <div className="grid gap-2 rounded-2xl border border-line bg-soft px-4 py-3.5">
                <p className="font-semibold text-ink">Apply with a one-pager instead of a CV</p>
                <p className="text-sm text-ink-muted">
                  Tell us what you want and connect your public work. We build a one-page PDF you can attach to any
                  application.
                </p>
                <Button asChild variant="outline" className="h-11 w-fit px-4">
                  <Link href="/start" onClick={() => setOpen(false)}>
                    Start my profile
                  </Link>
                </Button>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </>
  );
}
