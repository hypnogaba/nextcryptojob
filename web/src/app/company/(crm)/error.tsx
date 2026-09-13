"use client";

import { Button } from "@/components/ui/button";

/** Помилка сторінки CRM (специфікація 10.1): "Something went wrong. Try again." і номер для підтримки. */
export default function CrmError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto grid max-w-3xl gap-4 px-4 pt-8 pb-20 sm:px-6 sm:pt-12">
      <div role="alert" className="grid gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-ink">
        <p className="font-medium">Something went wrong. Try again.</p>
        {error.digest ? <p className="font-mono text-xs text-ink-muted">Request ID: {error.digest}</p> : null}
      </div>
      <Button type="button" variant="outline" className="h-11 w-fit px-4 text-base" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
