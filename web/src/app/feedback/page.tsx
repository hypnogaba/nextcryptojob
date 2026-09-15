import type { Metadata } from "next";
import { TestimonialForm } from "@/components/testimonial-form";
import { currentUser } from "@/lib/auth/session";
import { db } from "@/lib/db";

export const metadata: Metadata = {
  title: "Got a job through NextCryptoJob? Tell us | NextCryptoJob",
  description: "Tell us how NextCryptoJob helped you get hired. We may feature your story on the site with your permission.",
};

export default async function FeedbackPage() {
  const user = await currentUser();
  let defaultDisplayName = "";
  let hasXHandle = false;
  if (user) {
    const row = await db()
      .prepare("SELECT telegram_username, (SELECT 1 FROM identities WHERE user_id = ? AND kind = 'x' LIMIT 1) AS has_x FROM users WHERE id = ?")
      .bind(user.id, user.id)
      .first<{ telegram_username: string | null; has_x: number | null }>();
    defaultDisplayName = row?.telegram_username ?? "";
    hasXHandle = row?.has_x === 1;
  }

  return (
    <section className="mx-auto max-w-2xl px-[clamp(16px,4vw,32px)] pt-10 pb-24 sm:pt-16">
      <h1 className="display text-title">Got a job through NextCryptoJob? Tell us</h1>
      <p className="mt-3 text-lg text-ink-muted">
        Your story helps other candidates trust the score and helps companies trust the card. It takes a minute.
      </p>
      <div className="mt-8 border-t border-line pt-8">
        <TestimonialForm defaultDisplayName={defaultDisplayName} hasXHandle={hasXHandle} />
      </div>
    </section>
  );
}
