import Link from "next/link";

// Знак «Печатка»: лінії гільош-розетки чорнилом через маску /brand/seal-lines.svg на
// лимонному колі, як жетон. Кругла печатка лишилась від першої версії (власник 14.09),
// решта шапки з напряму «Payday». Файли бренду генерує scripts/brand-assets.py.
export function LogoMark({ className = "size-8" }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`relative inline-block shrink-0 rounded-full bg-lemon ${className}`}>
      <span
        className="absolute inset-[9%] bg-ink"
        style={{
          WebkitMask: "url(/brand/seal-lines.svg) center / contain no-repeat",
          mask: "url(/brand/seal-lines.svg) center / contain no-repeat",
        }}
      />
      <span className="absolute top-1/2 left-1/2 size-[16%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-ink" />
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
