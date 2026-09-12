"use client";

import type { ComponentProps } from "react";
import { useFormStatus } from "react-dom";
import { Button } from "@/components/ui/button";

/** Кнопка форми, що вимикається, поки форма працює, і може показати свій текст очікування. */
export function SubmitButton({
  pendingLabel,
  children,
  name,
  value,
  disabled,
  ...props
}: ComponentProps<typeof Button> & { pendingLabel?: string }) {
  const { pending, data } = useFormStatus();
  // У формі з кількома кнопками «працює» лише натиснута.
  const mine = pending && (name ? data?.get(String(name)) === value : true);
  return (
    <Button type="submit" name={name} value={value} disabled={pending || disabled} aria-busy={mine || undefined} {...props}>
      {mine && pendingLabel ? pendingLabel : children}
    </Button>
  );
}
