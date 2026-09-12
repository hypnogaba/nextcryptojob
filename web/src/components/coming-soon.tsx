import Link from "next/link";

export function ComingSoon({ title }: { title: string }) {
  return (
    <section className="mx-auto max-w-5xl px-4 py-20 sm:px-6 sm:py-28">
      <p className="font-mono text-xs tracking-widest text-brand uppercase">Coming soon</p>
      <h1 className="mt-4 text-3xl font-semibold tracking-tight sm:text-4xl">{title}</h1>
      <p className="mt-4 max-w-md text-ink-muted">
        This page is not ready yet. Check back shortly.
      </p>
      <Link
        href="/"
        className="mt-8 inline-block rounded-sm text-sm font-medium text-brand underline-offset-4 hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        Back to home
      </Link>
    </section>
  );
}
