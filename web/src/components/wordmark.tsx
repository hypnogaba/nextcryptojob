import Link from "next/link";

// Знак «Печатка»: лінії гільош-розетки чорнилом через маску /brand/seal-lines.svg на
// білому колі, як жетон (round4: без лимонного, крапка в центрі як на favicon).
// Кругла печатка лишилась від першої версії (власник 14.09). Файли бренду генерує
// scripts/brand-assets.py.
export function LogoMark({ className = "size-8" }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`relative inline-block shrink-0 rounded-full bg-white shadow-[inset_0_0_0_1px_var(--line)] ${className}`}>
      <span
        className="absolute inset-[9%] bg-ink"
        style={{
          WebkitMask: "url(/brand/seal-lines.svg) center / contain no-repeat",
          mask: "url(/brand/seal-lines.svg) center / contain no-repeat",
        }}
      />
      <span className="absolute top-1/2 left-1/2 size-[16%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#bb340e]" />
    </span>
  );
}

export function Wordmark() {
  return (
    <Link
      href="/"
      aria-label="NextCryptoJob home"
      className="inline-flex min-h-11 items-center gap-2.5 rounded-lg font-display text-[1.25rem] leading-none font-bold tracking-[-0.02em] text-ink max-sm:text-[1.0625rem]"
    >
      <LogoMark />
      <span>NextCryptoJob</span>
    </Link>
  );
}
