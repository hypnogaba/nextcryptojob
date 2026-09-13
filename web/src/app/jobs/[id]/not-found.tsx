import Link from "next/link";

/**
 * /jobs/<id> не жива (закрита, прихована, прострочена, компанія без підписки) або
 * такої немає: 404 з тим, що сказано в специфікації 5.6.
 */
export default function JobClosed() {
  return (
    <section className="mx-auto grid max-w-3xl gap-4 px-4 pt-10 pb-20 sm:px-6 sm:pt-16">
      <h1 className="text-3xl font-semibold tracking-tight">This job is closed.</h1>
      <p className="text-ink-muted">The company closed it, filled it or it expired. It no longer takes applications.</p>
      <p>
        <Link href="/" className="font-medium text-brand underline underline-offset-4">
          Get crypto jobs that match your track record
        </Link>
      </p>
    </section>
  );
}
