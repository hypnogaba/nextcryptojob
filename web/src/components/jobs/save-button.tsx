"use client";

import { Check } from "lucide-react";
import { useState, useTransition } from "react";
import { toggleSaveJobAction } from "@/app/jobs/save-actions";
import { Button } from "@/components/ui/button";

/**
 * «Save» на картці вакансії (раунд 5, п.16): натискання оптимістичне, відкочується на невдачі.
 * Заповнене тло (власник 16.09, п.5): контурна кнопка губилась поруч із чорним "Apply" і
 * рештою тексту картки. Тепер вона теж заповнена (те саме чорнило brand/primary, без нового
 * кольору), тож читається як дія одразу. Збережений стан інший: світліший фон і галочка,
 * щоб було видно різницю, не лише слово. Картка сама теж посилання (job-card.tsx, overlay
 * position:absolute z-0); ця кнопка лежить у шарі z-[1] поверх нього, а не всередині його
 * <a>, тож клік по ній не веде на сторінку вакансії.
 */
export function SaveButton({ jobRef, initialSaved, compact }: { jobRef: string; initialSaved: boolean; compact?: boolean }) {
  const [saved, setSaved] = useState(initialSaved);
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      size={compact ? "default" : "lg"}
      variant={saved ? "outline" : "default"}
      className={saved ? "border-2 border-ink bg-soft-2 hover:bg-soft-2" : undefined}
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
      {saved ? (
        <>
          <Check aria-hidden="true" data-icon="inline-start" />
          Saved
        </>
      ) : (
        "Save"
      )}
    </Button>
  );
}
