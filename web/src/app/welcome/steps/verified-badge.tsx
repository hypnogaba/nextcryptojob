import { CircleCheck } from "lucide-react";

/** «@handle, verified» зеленою плашкою. */
export function VerifiedBadge({ label }: { label: string }) {
  return (
    <p className="flex items-center gap-2 rounded-lg border border-brand bg-brand-soft px-3 py-3 text-ink">
      <CircleCheck aria-hidden className="size-5 shrink-0 text-brand" />
      <span>
        <span className="font-medium">{label}</span> is verified.
      </span>
    </p>
  );
}
