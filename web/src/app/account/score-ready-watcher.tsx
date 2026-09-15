"use client";

import { X } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { pollDelayMs } from "@/lib/score/result";
import { checkScoreReadyAction } from "./ready-actions";

/** Не турбуємо довше цього: людина, певно, ще не додала X чи джерела, чи пропустила зовсім. */
const GIVE_UP_AFTER_MS = 5 * 60_000;

/**
 * Раунд 5, п.2 + п.14 (веб-частина): людина, що натиснула «Skip, go to my account» (чи просто
 * пішла далі, поки бал ще рахувався), бачить сповіщення «Your card is ready» саме тут, коли бал
 * і картка з'являться, без повернення на /welcome/score. Опитує лише коли `watch` (сервер каже,
 * що анкету пройдено, і картки ще нема); зупиняється, щойно з'явилась картка чи людина закрила
 * сповіщення.
 */
export function ScoreReadyWatcher({ watch }: { watch: boolean }) {
  const [ready, setReady] = useState<{ slug: string; path: string } | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const started = useRef(0);

  useEffect(() => {
    if (!watch) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    started.current = Date.now();

    async function poll() {
      if (stopped) return;
      if (document.hidden || Date.now() - started.current > GIVE_UP_AFTER_MS) {
        timer = setTimeout(poll, 4_000);
        return;
      }
      try {
        const res = await checkScoreReadyAction();
        if (res.ready) {
          setReady({ slug: res.slug, path: res.path });
          return;
        }
      } catch {
        // Мережа зникла на мить: спробуємо ще раз нижче.
      }
      timer = setTimeout(poll, pollDelayMs(Date.now() - started.current));
    }

    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [watch]);

  if (!ready || dismissed) return null;
  return (
    <div role="status" aria-live="polite" className="flex items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4 sm:p-5">
      <p className="text-sm text-ink">
        Your card is ready.{" "}
        <Link href={ready.path} className="font-semibold text-ink underline decoration-line-strong underline-offset-4 hover:decoration-brand">
          Open your card
        </Link>
      </p>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
        className="inline-flex size-8 shrink-0 items-center justify-center rounded-full text-ink-muted hover:bg-soft hover:text-ink"
      >
        <X aria-hidden className="size-4" />
      </button>
    </div>
  );
}
