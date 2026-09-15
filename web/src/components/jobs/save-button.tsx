"use client";

import { useState, useTransition } from "react";
import { toggleSaveJobAction } from "@/app/jobs/save-actions";
import { Button } from "@/components/ui/button";

/** «Save» на картці вакансії (раунд 5, п.16): натискання оптимістичне, відкочується на невдачі. */
export function SaveButton({ jobRef, initialSaved, compact }: { jobRef: string; initialSaved: boolean; compact?: boolean }) {
  const [saved, setSaved] = useState(initialSaved);
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      size={compact ? "default" : "lg"}
      variant="outline"
      disabled={pending}
      aria-pressed={saved}
      onClick={() => {
        const next = !saved;
        setSaved(next);
        startTransition(async () => {
          const res = await toggleSaveJobAction(jobRef, next);
          if (!res.ok) setSaved(!next);
        });
      }}
    >
      {saved ? "Saved" : "Save"}
    </Button>
  );
}
