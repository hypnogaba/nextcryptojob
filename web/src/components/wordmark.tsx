import Link from "next/link";

export function Wordmark() {
  return (
    <Link
      href="/"
      aria-label="NextCryptoJob home"
      className="rounded-md font-heading text-sm font-semibold tracking-tight text-ink focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      Next<span className="text-brand">Crypto</span>Job
    </Link>
  );
}
