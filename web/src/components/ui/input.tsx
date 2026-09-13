import * as React from "react";
import { FIELD, TEXTAREA } from "@/components/form/styles";
import { cn } from "@/lib/utils";

/** Поле вводу: кут 0, лінія 1 px, фокус лінією акценту (див. form/styles.ts). */
function Input({ className, type = "text", ...props }: React.ComponentProps<"input">) {
  return <input type={type} data-slot="input" className={cn(FIELD, className)} {...props} />;
}

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return <textarea data-slot="textarea" className={cn(TEXTAREA, className)} {...props} />;
}

export { Input, Textarea };
