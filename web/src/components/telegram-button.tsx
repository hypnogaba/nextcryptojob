import { Send } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Посилання на вхід через Telegram. Звичайний <a>, не <Link>: Link міг би
 * заздалегідь смикнути /auth/telegram/start і поставити куку стану без натискання.
 */
export function TelegramButton({
  children,
  className,
  variant = "default",
}: {
  children: ReactNode;
  className?: string;
  variant?: "default" | "outline";
}) {
  return (
    <Button asChild variant={variant} className={cn("h-11 px-4 text-base", className)}>
      <a href="/auth/telegram/start" rel="nofollow">
        <Send aria-hidden className="size-4" />
        {children}
      </a>
    </Button>
  );
}
