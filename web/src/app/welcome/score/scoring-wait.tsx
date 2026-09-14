"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { nextPollStep, pollDelayMs } from "@/lib/score/result";
import type { ProfileStatus } from "@/lib/score/status";
import { ensureScoreAction } from "../actions/score";

/** Після стількох секунд чесно кажемо, що довше звичайного, і що сторінку можна закрити. */
const SLOW_AFTER_MS = 90_000;

/**
 * «Scoring your work…»: ставить бал у чергу (якщо треба) і питає /api/profile/status, поки рушій
 * на VPS не закінчить (зазвичай секунди, до хвилини). Коли бал готовий або завдання впало,
 * перебудовує сторінку, і сервер показує результат. Зупиняється, коли вкладка схована.
 */
export function ScoringWait({ initial }: { initial: ProfileStatus }) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const [elapsed, setElapsed] = useState(0);
  const [note, setNote] = useState<string | null>(null);
  const started = useRef(0);
  const nextEnqueueAt = useRef(0);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    started.current = Date.now();

    async function tick(current: ProfileStatus) {
      if (stopped) return;
      const now = Date.now();
      setElapsed(now - started.current);
      const step = nextPollStep(current);
      if (step === "done" || step === "failed") {
        router.refresh();
        return;
      }
      if (step === "enqueue" && now >= nextEnqueueAt.current) {
        try {
          const res = await ensureScoreAction();
          if (res.state === "wait") {
            nextEnqueueAt.current = Date.now() + res.seconds * 1000;
            setNote(null);
          } else if (res.state === "no_consent") {
            setNote("We need your consent to compute a score. Go back one step and tick the box.");
            return;
          } else {
            nextEnqueueAt.current = Date.now() + 5_000;
          }
        } catch {
          // Мережа зникла на мить: наступна спроба з наступним опитуванням.
        }
      }
      timer = setTimeout(poll, pollDelayMs(Date.now() - started.current));
    }

    async function poll() {
      if (stopped) return;
      if (document.hidden) {
        timer = setTimeout(poll, 2_000);
        return;
      }
      try {
        const res = await fetch("/api/profile/status", { cache: "no-store" });
        if (res.ok) {
          const next = (await res.json()) as ProfileStatus;
          setStatus(next);
          await tick(next);
          return;
        }
      } catch {
        // Спробуємо ще раз нижче.
      }
      timer = setTimeout(poll, pollDelayMs(Date.now() - started.current));
    }

    void tick(initial);
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [initial, router]);

  const running = status.job?.status === "running";
  const slow = elapsed > SLOW_AFTER_MS;
  return (
    <div role="status" aria-live="polite" className="grid gap-4 rounded-xl border border-line bg-surface p-5 sm:p-6">
      <div className="flex items-center gap-3">
        <span aria-hidden className="relative flex size-3 shrink-0">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand opacity-60 motion-reduce:animate-none" />
          <span className="relative inline-flex size-3 rounded-full bg-brand" />
        </span>
        <p className="font-display text-2xl font-extrabold text-ink">Scoring your work…</p>
      </div>
      <ol className="grid gap-1.5 text-sm">
        <li className="text-ink">1. Your roles and sources are saved.</li>
        <li className={running ? "text-ink" : "text-ink-muted"}>2. Reading your public X, wallets and other sources.</li>
        <li className="text-ink-muted">3. Your score, level and card.</li>
      </ol>
      <p className="text-sm text-ink-muted">
        {note ??
          (slow
            ? "It is taking longer than usual. You can leave this page: your score will be on your profile when it is ready."
            : "This usually takes from a few seconds to a minute. Keep this page open.")}
      </p>
    </div>
  );
}
