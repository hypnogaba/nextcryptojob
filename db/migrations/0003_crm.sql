-- NextCryptoJob, CRM компаній. Власник: web (CRM). Номер і перелік таблиць: docs/contracts.md §7.
-- Специфікація: docs/specs/2026-09-12-crm-agents-design.md (розділи 4 і 5).
-- Залежить від 0001_core (users, scores). Таблиць з 0002_auth (consents, audit_log) не посилає
-- зовнішніми ключами, лише читає їх у запитах.
-- Час у всіх колонках: UTC у форматі datetime('now') ('YYYY-MM-DD HH:MM:SS'); API віддає ISO 8601 з Z.
-- Публічні id мають префікс і 20 символів base62: co_, job_, int_, ss_, app_.
-- D1 завжди вмикає зовнішні ключі, тому ON DELETE CASCADE працює без PRAGMA.

-- Компанія або агенція. Агенція отримує доступ лише після ручного схвалення заявки.
CREATE TABLE IF NOT EXISTS companies (
    id                     TEXT PRIMARY KEY,                    -- 'co_…'
    name                   TEXT NOT NULL,
    kind                   TEXT NOT NULL DEFAULT 'company' CHECK (kind IN ('company', 'agency')),
    status                 TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('pending_review', 'active', 'suspended', 'rejected', 'closed')),
    status_reason          TEXT,                                -- для suspended/rejected, бачить власник
    website                TEXT,                                -- нормалізація як identities.site
    domain                 TEXT,                                -- хост без 'www.', нижній регістр
    domain_verified_at     TEXT,                                -- пошта власника на цьому домені
    country                TEXT,                                -- ISO 3166-1 alpha-2
    about                  TEXT,                                -- до 500 символів, бачить кандидат у запиті
    x_handle               TEXT,                                -- без '@', для згадки в пості @nextcryptojob
    billing_email          TEXT,
    terms_version          TEXT NOT NULL,                       -- версія умов для компаній
    terms_accepted_at      TEXT NOT NULL,
    -- Один вебхук на компанію в релізі 1. Секрет не зберігаємо: він виводиться з
    -- WEBHOOK_SIGNING_KEY, id компанії і версії (специфікація, розділ 7.6).
    webhook_url            TEXT,
    webhook_enabled        INTEGER NOT NULL DEFAULT 0,
    webhook_secret_version INTEGER NOT NULL DEFAULT 1,
    webhook_rotated_at     TEXT,                                -- 24 год після ротації підписуємо і старим секретом
    webhook_failing_since  TEXT,
    created_by             TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_companies_status ON companies(status, kind);
CREATE INDEX IF NOT EXISTS idx_companies_domain ON companies(domain);

-- Люди компанії. Член команди це звичайний users-рядок (той самий вхід поштою або Telegram).
-- Запрошення живе тут же з user_id = NULL, доки людина не прийме його.
CREATE TABLE IF NOT EXISTS company_members (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id        TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id           TEXT REFERENCES users(id) ON DELETE CASCADE,
    role              TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
    invite_email      TEXT,                                     -- нижній регістр
    invite_token_hash TEXT UNIQUE,                              -- hex SHA-256 токена з листа; NULL після прийняття
    invited_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
    invited_at        TEXT,                                     -- запрошення живе 7 днів
    joined_at         TEXT,
    last_seen_at      TEXT,
    CHECK (user_id IS NOT NULL OR invite_email IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_members_company_user
    ON company_members(company_id, user_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_members_company_invite
    ON company_members(company_id, invite_email) WHERE user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_members_user ON company_members(user_id);

-- Вакансії компанії. Живі (status='open', компанія з доступом) бачить рушій добірки
-- через подання company_jobs_live у 0004_billing.
CREATE TABLE IF NOT EXISTS company_jobs (
    id                 TEXT PRIMARY KEY,                        -- 'job_…'
    company_id         TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed')),
    title              TEXT NOT NULL,                           -- до 120 символів
    description        TEXT NOT NULL DEFAULT '',                -- простий текст до 5 000 символів
    roles              TEXT NOT NULL DEFAULT '[]',              -- JSON-масив ключів ролей (contracts §1), 1–3
    remote_mode        TEXT NOT NULL DEFAULT 'remote' CHECK (remote_mode IN ('remote', 'city', 'remote,city')),
    city               TEXT,
    country            TEXT,                                    -- ISO 3166-1 alpha-2
    salary_min         INTEGER,
    salary_max         INTEGER,
    salary_currency    TEXT,                                    -- ISO 4217, верхній регістр
    salary_period      TEXT CHECK (salary_period IN ('year', 'month')),
    apply_url          TEXT,                                    -- https:// або mailto:
    tags               TEXT NOT NULL DEFAULT '[]',
    created_via        TEXT NOT NULL CHECK (created_via IN ('web', 'rest', 'mcp')),
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_by_key_id  TEXT,                                    -- api_keys.id (0004), без FK
    x_post_state       TEXT NOT NULL DEFAULT 'none' CHECK (x_post_state IN ('none', 'queued', 'posted', 'skipped')),
    x_post_text        TEXT,                                    -- до 280 символів
    x_post_url         TEXT,
    x_queued_at        TEXT,
    x_posted_at        TEXT,
    digest_shown       INTEGER NOT NULL DEFAULT 0,              -- скільки разів потрапила в добірки (пише engine)
    apply_clicks       INTEGER NOT NULL DEFAULT 0,              -- переходи через /jobs/<id>/apply
    hidden_by_admin_at TEXT,
    published_at       TEXT,
    expires_at         TEXT,                                    -- published_at + 60 днів
    closed_at          TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (status <> 'open' OR (apply_url IS NOT NULL AND expires_at IS NOT NULL)),
    CHECK (remote_mode = 'remote' OR city IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_company_jobs_company ON company_jobs(company_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_company_jobs_open ON company_jobs(expires_at) WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_company_jobs_xqueue ON company_jobs(x_queued_at) WHERE x_post_state = 'queued';

-- Збережений пошук. seen_json тримає id кандидатів, про яких уже сповіщали, щоб
-- щоденне сповіщення казало лише про нових (окремої таблиці в §7 немає; до 2 000 id).
CREATE TABLE IF NOT EXISTS saved_searches (
    id                 TEXT PRIMARY KEY,                        -- 'ss_…'
    company_id         TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name               TEXT NOT NULL,                           -- до 80 символів
    filters_json       TEXT NOT NULL,                           -- об'єкт SearchFilters з docs/api/openapi.yaml
    sort               TEXT NOT NULL DEFAULT 'score' CHECK (sort IN ('score', 'level', 'coverage', 'newest')),
    alert              TEXT NOT NULL DEFAULT 'daily' CHECK (alert IN ('off', 'daily')),
    created_via        TEXT NOT NULL CHECK (created_via IN ('web', 'rest', 'mcp')),
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_by_key_id  TEXT,
    seen_json          TEXT NOT NULL DEFAULT '[]',
    last_alert_at      TEXT,
    last_match_count   INTEGER,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_saved_searches_company ON saved_searches(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_saved_searches_alert ON saved_searches(last_alert_at) WHERE alert = 'daily';

-- Воронка: одна картка на пару (компанія, кандидат). Нотатки й історія в pipeline_events.
-- Видалення акаунта кандидата видаляє картку разом з історією (каскад).
CREATE TABLE IF NOT EXISTS pipeline (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id       TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    stage            TEXT NOT NULL DEFAULT 'found'
                     CHECK (stage IN ('found', 'intro_requested', 'contact_shared', 'interview', 'hired', 'declined')),
    declined_by      TEXT CHECK (declined_by IN ('candidate', 'company')),
    role             TEXT,                                      -- роль, під яку знайшли (contracts §1)
    job_id           TEXT REFERENCES company_jobs(id) ON DELETE SET NULL,
    tags             TEXT NOT NULL DEFAULT '[]',                -- JSON-масив, до 10 тегів по 32 символи
    note_count       INTEGER NOT NULL DEFAULT 0,
    added_via        TEXT NOT NULL CHECK (added_via IN ('web', 'rest', 'mcp')),
    added_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    added_by_key_id  TEXT,
    stage_changed_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (company_id, user_id),
    CHECK (stage <> 'declined' OR declined_by IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_pipeline_company_stage ON pipeline(company_id, stage, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_pipeline_user ON pipeline(user_id);

-- Історія картки: зміни етапу, нотатки, теги, події знайомства, втрата видимості.
CREATE TABLE IF NOT EXISTS pipeline_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    pipeline_id   INTEGER NOT NULL REFERENCES pipeline(id) ON DELETE CASCADE,
    company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    kind          TEXT NOT NULL CHECK (kind IN (
                      'added', 'stage_changed', 'note', 'tags_changed', 'job_linked',
                      'intro_requested', 'intro_accepted', 'intro_declined', 'intro_expired',
                      'intro_canceled', 'contact_shared', 'visibility_lost', 'visibility_restored')),
    from_stage    TEXT,
    to_stage      TEXT,
    body          TEXT,                                         -- текст нотатки, до 2 000 символів
    meta_json     TEXT,                                         -- напр. {"intro_id":"int_…"} або {"tags":[…]}
    actor_kind    TEXT NOT NULL CHECK (actor_kind IN ('member', 'agent', 'candidate', 'system')),
    actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    actor_key_id  TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_card ON pipeline_events(pipeline_id, id);
CREATE INDEX IF NOT EXISTS idx_pipeline_events_company ON pipeline_events(company_id, id);

-- Запит на знайомство. mode='direct' + status='direct': кандидат обрав «нік одразу»,
-- контакт відкрито без запиту, але подія все одно записана.
-- contact_* це знімок у мить згоди: пізніші зміни ніку чи видимості його не оновлюють.
CREATE TABLE IF NOT EXISTS intros (
    id                   TEXT PRIMARY KEY,                      -- 'int_…'
    company_id           TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id              TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    pipeline_id          INTEGER REFERENCES pipeline(id) ON DELETE SET NULL,
    job_id               TEXT REFERENCES company_jobs(id) ON DELETE SET NULL,
    role                 TEXT,
    mode                 TEXT NOT NULL CHECK (mode IN ('approval', 'direct')),
    status               TEXT NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'accepted', 'declined', 'expired', 'canceled', 'direct')),
    message              TEXT NOT NULL,                         -- 20–600 символів від компанії
    hiring_for           TEXT,                                  -- агенції обов'язково: клієнт або 'Confidential client'
    requested_via        TEXT NOT NULL CHECK (requested_via IN ('web', 'rest', 'mcp')),
    requested_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    requested_by_key_id  TEXT,
    x402_payment_id      TEXT,                                  -- x402_payments.id (0004), без FK
    respond_token_hash   TEXT UNIQUE,                           -- hex SHA-256 токена з листа; NULL після відповіді
    notify_channel       TEXT CHECK (notify_channel IN ('email', 'telegram')),
    notified_at          TEXT,
    notify_error         TEXT,
    reminded_at          TEXT,                                  -- нагадування на 7-й день (later)
    expires_at           TEXT NOT NULL,                         -- created_at + 14 днів
    responded_at         TEXT,
    candidate_blocked    INTEGER NOT NULL DEFAULT 0,            -- «Decline and block this company»
    contact_kind         TEXT CHECK (contact_kind IN ('telegram', 'email')),
    contact_value        TEXT,                                  -- '@handle' або адреса пошти
    webhook_state        TEXT NOT NULL DEFAULT 'none' CHECK (webhook_state IN ('none', 'pending', 'delivered', 'failed')),
    webhook_event        TEXT CHECK (webhook_event IN ('intro.accepted', 'intro.declined', 'intro.expired')),
    webhook_attempts     INTEGER NOT NULL DEFAULT 0,
    webhook_next_at      TEXT,
    webhook_last_error   TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (status NOT IN ('accepted', 'direct') OR contact_value IS NOT NULL)
);
-- Не більше одного відкритого запиту від компанії до людини.
CREATE UNIQUE INDEX IF NOT EXISTS uq_intros_open ON intros(company_id, user_id) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_intros_pair ON intros(company_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intros_company_updated ON intros(company_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_intros_user ON intros(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_intros_expiry ON intros(expires_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_intros_webhook ON intros(webhook_next_at) WHERE webhook_state = 'pending';
CREATE INDEX IF NOT EXISTS idx_intros_blocked ON intros(company_id, user_id) WHERE candidate_blocked = 1;

-- Заявка агенції. Рядок companies (kind='agency', status='pending_review') створюється разом із нею.
CREATE TABLE IF NOT EXISTS agency_applications (
    id                TEXT PRIMARY KEY,                         -- 'app_…'
    company_id        TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    applicant_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    contact_name      TEXT NOT NULL,
    contact_email     TEXT NOT NULL,
    website           TEXT NOT NULL,
    country           TEXT NOT NULL,
    clients_text      TEXT NOT NULL,                            -- для кого наймають, до 1 000 символів
    volume_text       TEXT,                                     -- скільки наймів на квартал
    data_use_text     TEXT NOT NULL,                            -- як використовуватимуть профілі
    no_resale_ack     INTEGER NOT NULL CHECK (no_resale_ack = 1),
    status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'needs_info', 'approved', 'rejected')),
    reviewer_note     TEXT,                                     -- бачить заявник
    admin_note        TEXT,                                     -- лише адмінам
    reviewed_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at       TEXT,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_agency_apps_status ON agency_applications(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_agency_apps_open
    ON agency_applications(company_id) WHERE status IN ('pending', 'needs_info');

-- Індекси для пошуку кандидатів на таблицях ядра (лише індекси, без нових колонок;
-- controller повідомлено в специфікації, розділ 13).
CREATE INDEX IF NOT EXISTS idx_scores_role_score ON scores(role, score DESC);
CREATE INDEX IF NOT EXISTS idx_users_visible ON users(id) WHERE visible_to_companies = 1;

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0003_crm');
