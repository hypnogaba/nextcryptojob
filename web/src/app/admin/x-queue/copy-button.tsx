"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

/** "Copy": текст посту в буфер обміну; без доступу до буфера текст лишається виділити вручну. */
export function CopyButton({ text }: { text: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <Button
      type="button"
      variant="outline"
      className="h-11 px-3"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          setState("failed");
        }
      }}
    >
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Select the text to copy" : "Copy"}</span>
    </Button>
  );
}
