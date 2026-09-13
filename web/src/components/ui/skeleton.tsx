import { cn } from "@/lib/utils";

/** Заглушка під час завантаження (shadcn/ui Skeleton на токенах бренду). */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cn("animate-pulse rounded-md bg-wash motion-reduce:animate-none", className)} {...props} />;
}

export { Skeleton };
