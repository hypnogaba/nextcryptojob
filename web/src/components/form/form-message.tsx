import { cn } from "@/lib/utils";

export type FormMessage = { tone: "error" | "info" | "success"; text: string };

/** Повідомлення форми. Область завжди в DOM, щоб читач екрана оголошував зміну. */
export function FormMessageLine({ id, message, className }: { id?: string; message?: FormMessage; className?: string }) {
  return (
    <p
      id={id}
      role={message?.tone === "error" ? "alert" : "status"}
      className={cn(
        "min-h-5 text-sm",
        message?.tone === "error" ? "text-destructive" : message?.tone === "success" ? "text-brand" : "text-ink-muted",
        className,
      )}
    >
      {message?.text}
    </p>
  );
}
