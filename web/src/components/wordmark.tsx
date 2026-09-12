import Link from "next/link";

export function Wordmark() {
  return (
    <Link
      href="/"
      aria-label="NextCryptoJob home"
      className="inline-flex min-h-11 items-center rounded-md font-heading text-sm font-semibold tracking-tight text-ink"
    >
      Next<span className="text-brand">Crypto</span>Job
    </Link>
  );
}
