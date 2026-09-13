import Link from "next/link";
import { fnv1a } from "@/lib/card/pattern";
import { Seal } from "@/components/card/seal";

// Знак: маленька печатка з двох шарів (та сама розетка, що на картках) і
// назва вузьким прописним Big Shoulders. Акцент лише на «Crypto».
const MARK_SEED = fnv1a("nextcryptojob");

export function Wordmark() {
  return (
    <Link
      href="/"
      aria-label="NextCryptoJob home"
      className="inline-flex min-h-11 items-center gap-2 rounded-lg font-display text-[1.625rem] leading-none font-black tracking-[0.01em] text-ink uppercase"
    >
      <Seal
        seed={MARK_SEED}
        level={2}
        density="share"
        segments={4}
        inks={["currentColor", "var(--brand)"]}
        strokeWidth={9}
        className="size-7 shrink-0"
      />
      <span>
        Next<span className="text-brand">Crypto</span>Job
      </span>
    </Link>
  );
}
