"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { isActive, type ProfileStatus } from "@/lib/score/status";
import { RescoreButton } from "./rescore-button";

const POLL_MS = 5000;
/** Після стількох секунд у черзі чесно кажемо, що довше звичайного. */
const SLOW_AFTER_SECONDS = 180;

/**
 * Стан балу: поки завдання чекає чи рахується, питає /api/profile/status
 * кожні 5 с; коли воно закінчилось, оновлює сторінку, і та покаже бал.
 * Батько передає key зі стану, тож після оновлення панель починає заново.
 */
export function StatusPanel({ initial }: { initial: ProfileStatus }) {
  const router = useRouter();
  const [status, setStatus] = useState(initial);
  const active = isActive(status);

  useEffect(() => {
    if (!active) return;
    let stopped = false;
    const id = setInterval(async () => {
      if (document.hidden) return;
      try {
        const res = await fetch("/api/profile/status", { cache: "no-store" });
        if (!res.ok || stopped) return;
        const next = (await res.json()) as ProfileStatus;
        setStatus(next);
        if (!isActive(next)) router.refresh();
      } catch {
        // Мережа зникла на мить: наступна спроба за 5 с.
      }
    }, POLL_MS);
    return () => {
      stopped = true;
      clearInterval(id);
    };
  }, [active, router]);

  if (active) {
    const slow = (status.job?.waitedSeconds ?? 0) > SLOW_AFTER_SECONDS;
    return (
      <div role="status" className="flex items-start gap-3 rounded-xl border border-line bg-surface p-4 sm:p-5">
        <span aria-hidden className="relative mt-1.5 flex size-2.5 shrink-0">
          <span className="relative inline-flex size-2.5 rounded-full bg-brand" />
        </span>
        <div className="grid gap-1">
          <p className="font-medium text-ink">
            {status.job?.status === "running" ? "Collecting your public data now." : "Your score is in the queue."}
          </p>
          <p className="text-sm text-ink-muted">
            {slow
              ? "It is taking longer than usual. You can leave this page. Your score will be here when it is ready."
              : "We are collecting your public data. This usually takes under a minute."}
          </p>
        </div>
      </div>
    );
  }

  if (status.job?.status === "failed") {
    return (
      <div role="alert" className="grid gap-3 rounded-xl border border-destructive/50 bg-surface p-4 sm:p-5">
        <div className="grid gap-1">
          <p className="font-medium text-ink">We could not finish collecting your data.</p>
          <p className="text-sm text-ink-muted">
            A source did not answer in time. Nothing is wrong with your profile. Try again in a minute.
          </p>
        </div>
        <RescoreButton label="Try again" />
      </div>
    );
  }

  return null;
}
