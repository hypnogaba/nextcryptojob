import { RECIPES, type ScoredRoleKey } from "@/lib/roles/recipes";
import { CONTACT_CONSENT, SCORING_CONSENT, VISIBILITY_CONSENT } from "@/lib/consent";
import { grantManualAccess } from "@/lib/billing/manual";
import { COMPANY_TERMS_VERSION } from "@/lib/crm/company";
import { respondToIntro, type IntroDecision } from "@/lib/crm/intros";
import type { Notifier } from "@/lib/crm/notify";
import { FORMULA_VERSION } from "@/lib/crm/types";
import { newId } from "@/lib/ids";
import { sqlTime } from "@/lib/time";

/**
 * Демо-компанія для перевірки CRM без живої компанії (адмінка, «Create demo company»).
 *
 * Що створює: компанію «Demo Labs» (companies.is_demo = 1), власник = адмін, ручний пробний
 * доступ на DEMO_TRIAL_DAYS, і DEMO_CANDIDATES синтетичних кандидатів (users.is_demo = 1) з
 * різними ролями, балами, рівнями й режимом контакту. Гаманців немає.
 *
 * Ізоляція (правило видимості, lib/crm/visibility.ts): демо-кандидата бачить лише
 * демо-компанія, реальна компанія й гість x402 не бачать ніколи; демо-компанія не бачить
 * реальних людей. Добірки: у демо немає пошти й Telegram, digest_paused = 1, а engine ще й
 * відкидає is_demo = 1 (engine/src/digest/schedule.ts). Аналітика й лічильники адмінки демо
 * не рахують. Вакансії демо-компанії не стають живими (подання company_jobs_live, 0021).
 *
 * Контакти демо не можуть належати живим людям: нік Telegram з дефісом (у Telegram дефіс
 * заборонено), X з дефісом (у X теж), GitHub з двома дефісами поспіль (GitHub їх не дозволяє).
 * Пошти в демо немає.
 *
 * Знайомство з демо-кандидатом нікого не сповіщає (lib/crm/intros.ts notifyCandidate):
 * відповідь дає answerDemoIntro (кнопка в панелі кандидата) або settleDemoIntros, що
 * відповідає на запити, старші за DEMO_ANSWER_AFTER_MS, коли демо-компанія відкриває
 * профіль чи воронку. Хто з демо-кандидатів відмовляє, задано в DEMO_CANDIDATES (answer).
 */

export const DEMO_COMPANY_NAME = "Demo Labs";
export const DEMO_TRIAL_DAYS = 30;
/** Через скільки після запиту демо-кандидат «відповідає» сам. */
export const DEMO_ANSWER_AFTER_MS = 5_000;

type Role = ScoredRoleKey;

export interface DemoCandidate {
  /** Номер 1–12: з нього id (de00NN…) і мітка кандидата #DE00NN. */
  n: number;
  roles: { role: Role; score: number; cover?: number }[];
  remote: "remote" | "city" | "remote,city";
  city?: string;
  salary?: { min: number; currency: string };
  /** direct: «Telegram handle directly», компанія бачить нік одразу. */
  contact: "approval" | "direct";
  xVerified: boolean;
  github: boolean;
  /** Як демо-кандидат відповідає на знайомство. */
  answer: "accept" | "decline";
}

export const DEMO_CANDIDATES: readonly DemoCandidate[] = [
  { n: 1, roles: [{ role: "engineer", score: 88 }], remote: "remote", salary: { min: 160_000, currency: "USD" }, contact: "direct", xVerified: true, github: true, answer: "accept" },
  { n: 2, roles: [{ role: "engineer", score: 74 }, { role: "devrel", score: 52 }], remote: "remote,city", city: "Lisbon", salary: { min: 110_000, currency: "EUR" }, contact: "approval", xVerified: true, github: true, answer: "accept" },
  { n: 3, roles: [{ role: "engineer", score: 61, cover: 67 }], remote: "city", city: "Berlin", salary: { min: 85_000, currency: "EUR" }, contact: "approval", xVerified: false, github: true, answer: "accept" },
  { n: 4, roles: [{ role: "security_auditor", score: 81 }, { role: "engineer", score: 70 }], remote: "remote", salary: { min: 180_000, currency: "USD" }, contact: "direct", xVerified: true, github: true, answer: "accept" },
  { n: 5, roles: [{ role: "devrel", score: 67 }], remote: "remote", contact: "approval", xVerified: true, github: true, answer: "accept" },
  { n: 6, roles: [{ role: "data_research", score: 72 }, { role: "engineer", score: 44 }], remote: "remote", salary: { min: 95_000, currency: "USD" }, contact: "approval", xVerified: true, github: true, answer: "accept" },
  { n: 7, roles: [{ role: "product_manager", score: 58 }], remote: "remote,city", city: "London", salary: { min: 90_000, currency: "GBP" }, contact: "approval", xVerified: true, github: false, answer: "accept" },
  { n: 8, roles: [{ role: "bd", score: 79 }], remote: "remote", salary: { min: 120_000, currency: "USD" }, contact: "direct", xVerified: true, github: false, answer: "accept" },
  { n: 9, roles: [{ role: "bd", score: 46 }, { role: "community", score: 55 }], remote: "remote", contact: "approval", xVerified: true, github: false, answer: "decline" },
  { n: 10, roles: [{ role: "marketing_content", score: 69 }, { role: "creator_kol", score: 63 }], remote: "remote", salary: { min: 70_000, currency: "USD" }, contact: "approval", xVerified: true, github: false, answer: "accept" },
  { n: 11, roles: [{ role: "community", score: 38, cover: 50 }], remote: "city", city: "Kyiv", contact: "approval", xVerified: false, github: false, answer: "accept" },
  { n: 12, roles: [{ role: "trader", score: 84 }], remote: "remote", contact: "approval", xVerified: true, github: false, answer: "decline" },
];

const DAY_MS = 86_400_000;

/** id демо-кандидата: uuid v4 з початком de00NN (мітка в CRM #DE00NN) і випадковим хвостом. */
export function demoUserId(n: number): string {
  const hex = Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, "0")).join("");
  return `de00${String(n).padStart(2, "0")}00-0000-4000-8000-${hex}`;
}

/** Нік демо з дефісом: у Telegram дефіс заборонено, тож такого живого акаунта немає. */
export function demoHandle(n: number): string {
  return `ncj-demo-${String(n).padStart(2, "0")}`;
}

/** Бали джерел ядра й додатків, з яких складається бал ролі (рецепт v6, перший шлях). */
export function demoBreakdown(role: Role, score: number, cover: number, formula: string): Record<string, unknown> {
  const recipe = RECIPES[role];
  const path = recipe.paths[0];
  const core: Record<string, { weight: number; value: number | null }> = {};
  const gaps: Record<string, string> = {};
  path.forEach(([source, weight], i) => {
    // Головне джерело трохи вище за бал, решта нижче: разом близько до балу ролі.
    const value = Math.max(0, Math.min(100, Math.round(score + (i === 0 ? 6 : -14 + i * 3))));
    // Неповне покриття: останнє джерело ядра без даних (прогалина, а не нуль).
    const missing = cover < 100 && i === path.length - 1 && path.length > 1;
    core[source] = { weight, value: missing ? null : value };
    if (missing) gaps[source === "x" ? "x" : "github"] = "timeout";
  });
  const bonus: Record<string, { max: number; value: number }> = {};
  recipe.bonus.forEach(([source, max]) => {
    // Гаманців у демо немає: ончейн-додаток 0; сайт чи GitHub дає половину балу.
    bonus[source] = { max, value: source === "onchain" ? 0 : Math.round(score / 2) };
  });
  return { formula, core, bonus, cover, level: null, reason: null, gaps };
}

type Batch = D1PreparedStatement[];

/** Версія формули, яку бачать компанії: остання з вдалим прогоном воріт якості, інакше чинна з договору. */
async function publishedFormula(db: D1Database): Promise<{ version: string; published: boolean }> {
  const v = await db
    .prepare("SELECT formula_version FROM quality_runs WHERE passed = 1 ORDER BY id DESC LIMIT 1")
    .first<string>("formula_version");
  return v ? { version: v, published: true } : { version: FORMULA_VERSION, published: false };
}

function seedCandidate(db: D1Database, c: DemoCandidate, formula: string, at: string): Batch {
  const id = demoUserId(c.n);
  const statements: Batch = [
    db
      .prepare(
        `INSERT INTO users (id, email, telegram_id, telegram_username, channel, target_text, roles, remote_mode, city,
                            salary_min, salary_currency, visible_to_companies, contact_mode, onboarding_step,
                            digest_paused, is_demo, created_at, last_active_at)
         VALUES (?, NULL, NULL, ?, 'email', 'Demo candidate', ?, ?, ?, ?, ?, 1, ?, 'done', 1, 1, ?, ?)`,
      )
      .bind(id, demoHandle(c.n), JSON.stringify(c.roles.map((r) => r.role)), c.remote, c.city ?? null,
        c.salary?.min ?? null, c.salary?.currency ?? null, c.contact, at, at),
  ];
  const consents: [string, string][] = [
    [SCORING_CONSENT.kind, SCORING_CONSENT.version],
    [VISIBILITY_CONSENT.kind, VISIBILITY_CONSENT.version],
  ];
  if (c.contact === "direct") consents.push([CONTACT_CONSENT.kind, CONTACT_CONSENT.version]);
  for (const [kind, version] of consents) {
    statements.push(
      db.prepare("INSERT INTO consents (user_id, kind, granted, text_version, at) VALUES (?, ?, 1, ?, ?)").bind(id, kind, version, at),
    );
  }
  for (const r of c.roles) {
    const cover = r.cover ?? 100;
    statements.push(
      db
        .prepare(
          `INSERT INTO scores (user_id, role, score, core, cover, breakdown_json, formula_version, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, r.role, r.score, r.score, cover, JSON.stringify(demoBreakdown(r.role, r.score, cover, formula)), formula, at),
    );
  }
  const tag = String(c.n).padStart(2, "0");
  if (c.xVerified) {
    statements.push(
      db
        .prepare("INSERT INTO identities (user_id, kind, value, verified_via, verified_at) VALUES (?, 'x', ?, 'bio_code', ?)")
        .bind(id, `ncj-demo-${tag}`, at),
    );
  }
  if (c.github) {
    statements.push(
      db.prepare("INSERT INTO identities (user_id, kind, value) VALUES (?, 'github', ?)").bind(id, `ncj--demo-${tag}`),
    );
  }
  return statements;
}

export interface DemoState {
  companies: { id: string; name: string; ownerIsYou: boolean }[];
  candidates: number;
  intros: number;
  formula: { version: string; published: boolean };
}

/**
 * Id демо-компанії цього адміна, чи null (п.19: «View as company» в меню адмінки, той самий
 * openDemoAction, що кнопка «Open demo» в блоці Demo company). Один легкий запит, не весь demoState:
 * рендериться на кожній сторінці адмінки (AdminNav).
 */
export async function myDemoCompanyId(db: D1Database, adminUserId: string): Promise<string | null> {
  const row = await db
    .prepare(`SELECT c.id FROM companies c JOIN company_members m ON m.company_id = c.id AND m.user_id = ? WHERE c.is_demo = 1 LIMIT 1`)
    .bind(adminUserId)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/** Що з демо вже є (для адмінки). */
export async function demoState(db: D1Database, adminUserId: string): Promise<DemoState> {
  const [companies, counts] = await db.batch([
    db
      .prepare(
        `SELECT c.id, c.name, EXISTS (SELECT 1 FROM company_members m WHERE m.company_id = c.id AND m.user_id = ?) AS mine
           FROM companies c WHERE c.is_demo = 1 ORDER BY c.created_at`,
      )
      .bind(adminUserId),
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM users WHERE is_demo = 1) AS candidates,
              (SELECT COUNT(*) FROM intros WHERE company_id IN (SELECT id FROM companies WHERE is_demo = 1)) AS intros`,
    ),
  ]);
  const c = (counts.results[0] ?? {}) as { candidates?: number; intros?: number };
  return {
    companies: (companies.results as { id: string; name: string; mine: number }[]).map((r) => ({
      id: r.id,
      name: r.name,
      ownerIsYou: r.mine === 1,
    })),
    candidates: Number(c.candidates) || 0,
    intros: Number(c.intros) || 0,
    formula: await publishedFormula(db),
  };
}

export type CreateDemoResult = { companyId: string; created: boolean; candidates: number };

/**
 * Створити демо-компанію адміна й демо-кандидатів. Повторний виклик нічого не дублює:
 * якщо в адміна вже є демо-компанія, лише досіює кандидатів, яких бракує.
 */
export async function createDemo(db: D1Database, adminUserId: string, now: Date = new Date()): Promise<CreateDemoResult> {
  const at = sqlTime(now);
  const existing = await db
    .prepare(
      `SELECT c.id FROM companies c JOIN company_members m ON m.company_id = c.id AND m.user_id = ?
        WHERE c.is_demo = 1 AND c.status = 'active' ORDER BY c.created_at LIMIT 1`,
    )
    .bind(adminUserId)
    .first<string>("id");

  let companyId = existing;
  if (!companyId) {
    companyId = newId("co");
    await db.batch([
      db
        .prepare(
          `INSERT INTO companies (id, name, kind, status, about, terms_version, terms_accepted_at, created_by, is_demo,
                                  created_at, updated_at)
           VALUES (?, ?, 'company', 'active', ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(companyId, DEMO_COMPANY_NAME, "Demo company for testing NextCryptoJob. Its candidates are synthetic.",
          COMPANY_TERMS_VERSION, at, adminUserId, at, at),
      db
        .prepare("INSERT INTO company_members (company_id, user_id, role, joined_at, last_seen_at) VALUES (?, ?, 'owner', ?, ?)")
        .bind(companyId, adminUserId, at, at),
      db
        .prepare("INSERT INTO audit_log (actor, action, target, meta_json, at) VALUES (?, 'demo.create', NULL, ?, ?)")
        .bind(`admin:${adminUserId}`, JSON.stringify({ company_id: companyId }), at),
    ]);
    const grant = await grantManualAccess(db, {
      companyId,
      status: "trialing",
      periodEnd: new Date(now.getTime() + DEMO_TRIAL_DAYS * DAY_MS),
      note: "Demo company for testing",
      adminUserId,
      now,
    });
    if (!grant.ok) throw new Error(`demo: access not granted: ${grant.reason}`);
  }

  const have = await db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_demo = 1").first<number>("n");
  let seeded = 0;
  if (!have) {
    const { version } = await publishedFormula(db);
    await db.batch(DEMO_CANDIDATES.flatMap((c) => seedCandidate(db, c, version, at)));
    seeded = DEMO_CANDIDATES.length;
  }
  return { companyId, created: !existing, candidates: seeded || Number(have) || 0 };
}

/**
 * Стерти все демо: демо-компанії (каскад: команда, доступ, воронка, знайомства, вакансії,
 * пошуки, ключі) і демо-кандидатів (каскад: бали, згоди, джерела). Журнал лишається.
 */
export async function deleteDemo(db: D1Database, adminUserId: string, now: Date = new Date()): Promise<{ companies: number; candidates: number }> {
  const at = sqlTime(now);
  const [companies, users] = await db.batch([
    db.prepare("DELETE FROM companies WHERE is_demo = 1"),
    db.prepare("DELETE FROM users WHERE is_demo = 1"),
    db
      .prepare("INSERT INTO audit_log (actor, action, target, meta_json, at) VALUES (?, 'demo.delete', NULL, NULL, ?)")
      .bind(`admin:${adminUserId}`, at),
  ]);
  return { companies: companies.meta.changes ?? 0, candidates: users.meta.changes ?? 0 };
}

type PendingDemoIntro = { id: string; user_id: string; created_at: string };

/** Як відповідає цей демо-кандидат (за номером у його id). */
export function demoAnswerFor(userId: string): IntroDecision {
  const n = Number.parseInt(userId.slice(4, 6), 10);
  return DEMO_CANDIDATES.find((c) => c.n === n)?.answer === "decline" ? "decline" : "accept";
}

const PENDING_DEMO_SQL = `SELECT i.id, i.user_id, i.created_at FROM intros i
  JOIN companies c ON c.id = i.company_id AND c.is_demo = 1
  JOIN users u ON u.id = i.user_id AND u.is_demo = 1
 WHERE i.company_id = ? AND i.status = 'pending' AND i.respond_token_hash IS NOT NULL`;

export type DemoAnswer = { ok: true; decision: IntroDecision } | { ok: false; reason: "not_demo" | "not_pending" };

/**
 * Відповісти за демо-кандидата (кнопка «Simulate the answer» у демо-компанії). Лише
 * знайомство демо-компанії з демо-кандидатом; інше не чіпає. Відповідь іде тим самим
 * шляхом, що й від живої людини (respondToIntro): картка, журнал, вебхук, лист тому, хто просив.
 */
export async function answerDemoIntro(
  db: D1Database,
  input: { companyId: string; introId: string; decision: IntroDecision; notifier: Notifier; now?: Date },
): Promise<DemoAnswer> {
  const row = await db
    .prepare(`${PENDING_DEMO_SQL} AND i.id = ?`)
    .bind(input.companyId, input.introId)
    .first<PendingDemoIntro>();
  if (!row) {
    const any = await db
      .prepare(
        `SELECT 1 AS yes FROM intros i JOIN companies c ON c.id = i.company_id AND c.is_demo = 1
           JOIN users u ON u.id = i.user_id AND u.is_demo = 1 WHERE i.id = ? AND i.company_id = ?`,
      )
      .bind(input.introId, input.companyId)
      .first();
    return { ok: false, reason: any ? "not_pending" : "not_demo" };
  }
  const outcome = await respondToIntro(db, {
    introId: row.id,
    userId: row.user_id,
    decision: input.decision,
    via: "web",
    notifier: input.notifier,
    now: input.now,
  });
  return outcome.kind === "accepted" || outcome.kind === "declined" ? { ok: true, decision: input.decision } : { ok: false, reason: "not_pending" };
}

/**
 * Демо-кандидати «відповідають» самі: запити демо-компанії, старші за DEMO_ANSWER_AFTER_MS,
 * отримують відповідь з DEMO_CANDIDATES. Кличе профіль і воронка демо-компанії під час
 * показу (як ліниве прострочення знайомств). Реальної компанії не торкається.
 */
export async function settleDemoIntros(
  db: D1Database,
  companyId: string,
  notifier: Notifier,
  now: Date = new Date(),
): Promise<number> {
  const { results } = await db
    .prepare(`${PENDING_DEMO_SQL} AND i.created_at <= ? LIMIT 20`)
    .bind(companyId, sqlTime(new Date(now.getTime() - DEMO_ANSWER_AFTER_MS)))
    .all<PendingDemoIntro>();
  let answered = 0;
  for (const row of results) {
    const res = await answerDemoIntro(db, { companyId, introId: row.id, decision: demoAnswerFor(row.user_id), notifier, now });
    if (res.ok) answered++;
  }
  return answered;
}

/** Для тестів: випадковий хвіст не заважає впізнати демо-id. */
export function isDemoUserId(id: string): boolean {
  return /^de00\d{2}00-0000-4000-8000-[0-9a-f]{12}$/.test(id);
}
