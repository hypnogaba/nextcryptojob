import { Skeleton } from "@/components/ui/skeleton";

/** Поки сторінка CRM завантажується: заглушки замість списку й карток (специфікація 10.1). */
export default function CrmLoading() {
  return (
    <div className="mx-auto grid max-w-6xl gap-4 px-4 pt-8 pb-20 sm:px-6 sm:pt-12" aria-busy="true" aria-label="Loading">
      <Skeleton className="h-9 w-48" />
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} className="h-36" />
        ))}
      </div>
      <Skeleton className="h-24" />
      <Skeleton className="h-24" />
    </div>
  );
}
