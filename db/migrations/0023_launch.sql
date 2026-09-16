-- NextCryptoJob, доріжка web: готовність до перших тестерів (пачка 2).
-- Контакт (A: contact_messages), відгуки «знайшов роботу через нас» (B: testimonials),
-- денні лічильники продуктової воронки (D: funnel_days), яких ще не пишемо: старт брифу,
-- клік «Share on X», клік «Apply». Решта кроків воронки й розбір балу (C) читають наявні
-- таблиці (users, identities, scores, source_facts, quality_runs, visit_days) без нової схеми.
-- Час: TEXT у форматі datetime('now'), UTC (договір §9).
-- Накочує controller, ДО деплою коду. Код не падає, якщо ця міграція ще не накочена: кожне
-- читання цих таблиць ловить "no such table" і показує порожній стан (docs/contracts.md §7).

-- Лист із /contact (A). topic: чому пише людина; message без обмеження на кирилицю (лише
-- довжина). answered_at не NULL = адмін позначив «Marked answered» у /admin/messages.
-- ip_hash: HMAC(SESSION_SECRET, IP) для обмеження частоти й антиспаму, не сама IP.
CREATE TABLE IF NOT EXISTS contact_messages (
    id           TEXT PRIMARY KEY,                          -- msg_...
    email        TEXT NOT NULL,
    topic        TEXT NOT NULL CHECK (topic IN ('candidate', 'company', 'press', 'other')),
    message      TEXT NOT NULL,
    ip_hash      TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    answered_at  TEXT
);
CREATE INDEX IF NOT EXISTS idx_contact_messages_created ON contact_messages(created_at);

-- Відгук «Got a job through NextCryptoJob? Tell us» (B), з /feedback. user_id nullable:
-- форма працює й для відвідувача без акаунта (лише текст, без прив'язки). display керує,
-- що видно на публічному блоці (компонент Testimonials, поки ніде не підключений):
-- 'name' = display_name як є, 'handle' = @X-нік людини, 'anonymous' = без імені.
-- consent_public: людина дозволила показати відгук публічно; без нього status лишається
-- 'pending' і адмін бачить його лише в /admin/testimonials, approve не покаже його на сайті.
-- ON DELETE CASCADE (як cards, права людини на видалення сильніші за публічний відгук,
-- lib/account/erase.ts, erase.test.ts перевіряє, що кожен user_id каскадний): видалення
-- акаунта прибирає й відгук, навіть уже показаний публічно.
CREATE TABLE IF NOT EXISTS testimonials (
    id             TEXT PRIMARY KEY,                         -- tst_...
    user_id        TEXT REFERENCES users(id) ON DELETE CASCADE,
    display_name   TEXT,
    company        TEXT,
    role           TEXT,
    text           TEXT NOT NULL,
    display        TEXT NOT NULL CHECK (display IN ('name', 'handle', 'anonymous')),
    consent_public INTEGER NOT NULL DEFAULT 0,
    status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'hidden')),
    created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_testimonials_status ON testimonials(status, created_at);

-- Продуктова воронка (D, /admin/funnel): денні лічильники подій, яких інші таблиці не
-- дають напряму. Без персональних даних і без прив'язки до людини, як visit_days (0021):
-- лише день, крок і скільки разів. step: 'brief_started' (GET /start), 'share_click'
-- (клік «Share on X» на /c/[slug], редірект через /go/share-x), 'apply_click' (клік
-- «Apply» з публічної вакансії, /jobs/[id]/apply, паралельно з company_jobs.apply_clicks).
-- Решта кроків воронки рахуються з наявних таблиць: відвідувачі (visit_days), X/гаманець
-- додано (identities.created_at), бал готовий (scores.computed_at), картка переглянута
-- (visit_days, path_group = 'card'), добірка активна (users.digest_paused = 0).
CREATE TABLE IF NOT EXISTS funnel_days (
    day   TEXT NOT NULL,
    step  TEXT NOT NULL,
    count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, step)
) WITHOUT ROWID;

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0023_launch');
