"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { issueFirstCardAction } from "../actions/score";

/** Бал готовий, картки ще немає: робимо її одразу (одним POST) і перебудовуємо сторінку. */
export function IssueCard({ role, auto = true, label = "Make my card" }: { role: string; auto?: boolean; label?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(auto);
  const once = useRef(false);

  async function issue() {
    setBusy(true);
    setError(null);
    try {
      const res = await issueFirstCardAction(role);
      if (res.ok) router.refresh();
      else {
        setError(res.message);
        setBusy(false);
      }
    } catch {
      setError("Something went wrong. Try again.");
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!auto || once.current) return;
    once.current = true;
    void issue();
    // Лише раз при показі.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="grid gap-2" role="status" aria-live="polite">
      {busy ? <p className="text-sm text-ink-muted">Making your card…</p> : null}
      {!busy ? (
        <Button type="button" size="lg" className="w-full sm:w-fit" onClick={() => void issue()}>
          {label}
        </Button>
      ) : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
