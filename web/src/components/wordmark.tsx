import Link from "next/link";

// Знак «Печатка» (обраний логотип): лінії розетки кольором тексту через маску
// /brand/seal-lines.svg, тож він сам міняється зі світлою й темною темою, і одна
// помаранчева точка в центрі. Файли бренду генерує scripts/brand-assets.py.
export function LogoMark({ className = "size-7" }: { className?: string }) {
  return (
    <span aria-hidden="true" className={`relative inline-block shrink-0 ${className}`}>
      <span
        className="absolute inset-0 bg-current"
        style={{
          WebkitMask: "url(/brand/seal-lines.svg) center / contain no-repeat",
          mask: "url(/brand/seal-lines.svg) center / contain no-repeat",
        }}
      />
      <span className="absolute top-1/2 left-1/2 size-[12%] -translate-x-1/2 -translate-y-1/2 rounded-full bg-brand" />
    </span>
  );
}

export function Wordmark() {
  return (
    <Link
      href="/"
      aria-label="NextCryptoJob home"
      className="inline-flex min-h-11 items-center gap-2 rounded-lg font-display text-[1.625rem] leading-none font-black tracking-[0.01em] text-ink uppercase"
    >
      <LogoMark />
      <span>
        Next<span className="text-brand">Crypto</span>Job
      </span>
    </Link>
  );
}
