import { listApprovedTestimonials } from "@/lib/testimonials";

/**
 * Публічний блок відгуків (B). Показує лише approved і з consent_public. Порожньо =
 * нічого не рендерить (кнопка не показувати їх на головній, поки їх 0, лишається на
 * тому, хто підключає компонент). Не підключений ще ніде: головна лишається без змін
 * (round4 редизайн головної в іншій гілці).
 */
export async function Testimonials({ db, limit = 6 }: { db: D1Database; limit?: number }) {
  const items = await listApprovedTestimonials(db, limit);
  if (items.length === 0) return null;
  return (
    <section aria-labelledby="testimonials-title" className="grid gap-6">
      <h2 id="testimonials-title" className="display text-2xl">
        People who got hired
      </h2>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((t) => (
          <li key={t.id} className="grid gap-2 rounded-xl border border-line bg-surface p-4 sm:p-6">
            <p className="text-ink">{t.text}</p>
            <p className="text-sm text-ink-muted">
              {[t.name, t.role, t.company].filter(Boolean).join(", ") || "A NextCryptoJob candidate"}
            </p>
          </li>
        ))}
      </ul>
    </section>
  );
}
