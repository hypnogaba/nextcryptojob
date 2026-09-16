import { newId } from "@/lib/ids";
import { sqlTime } from "@/lib/time";

/**
 * «Got a job through NextCryptoJob? Tell us» (B):
 * /feedback (кожен, підключений чи ні) і /admin/testimonials (approve/hide). Таблиця
 * testimonials (0023). Публічний блок (components/testimonials.tsx) читає лише approved.
 */

export const TESTIMONIAL_DISPLAY = ["name", "handle", "anonymous"] as const;
export type TestimonialDisplay = (typeof TESTIMONIAL_DISPLAY)[number];
export function isTestimonialDisplay(v: unknown): v is TestimonialDisplay {
  return typeof v === "string" && (TESTIMONIAL_DISPLAY as readonly string[]).includes(v);
}

export const TESTIMONIAL_STATUS = ["pending", "approved", "hidden"] as const;
export type TestimonialStatus = (typeof TESTIMONIAL_STATUS)[number];

export const TEXT_MAX = 2000;
export const TEXT_MIN = 10;
export const FIELD_MAX = 120;

export type SubmitTestimonialInput = {
  userId: string | null;
  displayName: unknown;
  company: unknown;
  role: unknown;
  text: unknown;
  display: unknown;
  consentPublic: unknown;
};

export type SubmitTestimonialResult = { ok: true; id: string } | { ok: false; reason: "text_too_short" | "text_too_long" | "invalid_display" };

function cleanField(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/\s+/g, " ").trim().slice(0, max);
  return s.length > 0 ? s : null;
}

function toBool(v: unknown): boolean {
  return v === true || v === 1 || v === "1" || v === "true" || v === "on";
}

/** Записує відгук зі статусом 'pending': адмін затверджує, перш ніж він з'явиться публічно. */
export async function submitTestimonial(db: D1Database, input: SubmitTestimonialInput, now: Date = new Date()): Promise<SubmitTestimonialResult> {
  if (!isTestimonialDisplay(input.display)) return { ok: false, reason: "invalid_display" };
  const text = typeof input.text === "string" ? input.text.replace(/\s+/g, " ").trim() : "";
  if (text.length < TEXT_MIN) return { ok: false, reason: "text_too_short" };
  if (text.length > TEXT_MAX) return { ok: false, reason: "text_too_long" };

  const id = newId("tst");
  await db
    .prepare(
      `INSERT INTO testimonials (id, user_id, display_name, company, role, text, display, consent_public, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    )
    .bind(
      id,
      input.userId,
      cleanField(input.displayName, FIELD_MAX),
      cleanField(input.company, FIELD_MAX),
      cleanField(input.role, FIELD_MAX),
      text,
      input.display,
      toBool(input.consentPublic) ? 1 : 0,
      sqlTime(now),
    )
    .run();
  return { ok: true, id };
}

export type AdminTestimonialRow = {
  id: string;
  userId: string | null;
  displayName: string | null;
  company: string | null;
  role: string | null;
  text: string;
  display: TestimonialDisplay;
  consentPublic: boolean;
  status: TestimonialStatus;
  createdAt: string;
  userEmail: string | null;
};

type Row = {
  id: string;
  user_id: string | null;
  display_name: string | null;
  company: string | null;
  role: string | null;
  text: string;
  display: string;
  consent_public: number;
  status: string;
  created_at: string;
  user_email: string | null;
};

export type TestimonialList = { rows: AdminTestimonialRow[]; available: boolean; error: string | null };

function fromRow(r: Row): AdminTestimonialRow {
  return {
    id: r.id,
    userId: r.user_id,
    displayName: r.display_name,
    company: r.company,
    role: r.role,
    text: r.text,
    display: r.display as TestimonialDisplay,
    consentPublic: r.consent_public === 1,
    status: r.status as TestimonialStatus,
    createdAt: r.created_at,
    userEmail: r.user_email,
  };
}

/** Усі відгуки для /admin/testimonials, найновіші спершу. Таблиці ще немає: порожній список. */
export async function listTestimonialsForAdmin(db: D1Database, limit = 300): Promise<TestimonialList> {
  try {
    const { results } = await db
      .prepare(
        `SELECT t.id, t.user_id, t.display_name, t.company, t.role, t.text, t.display, t.consent_public, t.status,
                t.created_at, u.email AS user_email
           FROM testimonials t LEFT JOIN users u ON u.id = t.user_id
          ORDER BY t.created_at DESC LIMIT ?`,
      )
      .bind(limit)
      .all<Row>();
    return { rows: results.map(fromRow), available: true, error: null };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) return { rows: [], available: false, error: "Testimonials start after migration 0023 is applied." };
    throw error;
  }
}

export type SetStatusResult = { ok: true } | { ok: false; reason: "not_found" };

export async function setTestimonialStatus(db: D1Database, id: string, status: TestimonialStatus): Promise<SetStatusResult> {
  const res = await db.prepare("UPDATE testimonials SET status = ? WHERE id = ?").bind(status, id).run();
  return (res.meta.changes ?? 0) > 0 ? { ok: true } : { ok: false, reason: "not_found" };
}

export type PublicTestimonial = { id: string; name: string | null; company: string | null; role: string | null; text: string };

/**
 * Лише approved і consent_public. `name`: display 'name' → display_name, 'handle' → @X-нік
 * підключеного акаунта (якщо є), 'anonymous' або немає чим показати → null (текст без імені).
 * Таблиці немає: порожній список, компонент Testimonials тоді не рендерить нічого.
 */
export async function listApprovedTestimonials(db: D1Database, limit = 12): Promise<PublicTestimonial[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT t.id, t.display_name, t.company, t.role, t.text, t.display,
                (SELECT i.value FROM identities i WHERE i.user_id = t.user_id AND i.kind = 'x' LIMIT 1) AS x_handle
           FROM testimonials t
          WHERE t.status = 'approved' AND t.consent_public = 1
          ORDER BY t.created_at DESC LIMIT ?`,
      )
      .bind(limit)
      .all<{ id: string; display_name: string | null; company: string | null; role: string | null; text: string; display: string; x_handle: string | null }>();
    return results.map((r) => ({
      id: r.id,
      name: r.display === "name" ? r.display_name : r.display === "handle" && r.x_handle ? `@${r.x_handle}` : null,
      company: r.company,
      role: r.role,
      text: r.text,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/no such table/i.test(message)) return [];
    throw error;
  }
}
