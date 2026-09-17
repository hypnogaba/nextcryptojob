"use server";

import { currentUser } from "@/lib/auth/session";
import { listActiveCards } from "@/lib/card/store";
import { db } from "@/lib/db";

/**
 * Чи має людина картку, з якої будується її PDF на одну сторінку (власник 17.09: «на сторінці
 * роботи ми не пропонуємо людині створювати цей PDF»). Питає вікно вибору подачі, коли людина
 * його відкриває: так картка вакансії лишається серверною й однаковою для всіх, а слово про PDF
 * бере свіжий стан саме цієї людини.
 *
 * - "anon": не ввійшла. Пропонуємо зробити профіль.
 * - "no-card": ввійшла, картки ще немає. Пропонуємо її створити.
 * - "card": є картка, віддаємо адресу PDF (за сесією, /c/<код>/profile.pdf).
 */
export type ProofState = { state: "anon" } | { state: "no-card" } | { state: "card"; pdf: string; card: string };

export async function myProofAction(): Promise<ProofState> {
  const user = await currentUser();
  if (!user) return { state: "anon" };
  let cards;
  try {
    cards = await listActiveCards(db(), user.id);
  } catch (err) {
    console.warn("apply choice: cards read failed:", err instanceof Error ? err.message : String(err));
    return { state: "no-card" };
  }
  const best = cards.length > 0 ? cards.reduce((a, b) => (b.score > a.score ? b : a)) : null;
  if (!best) return { state: "no-card" };
  return { state: "card", pdf: `/c/${best.slug}/profile.pdf`, card: `/c/${best.slug}` };
}
