-- NextCryptoJob, спільне ядро схеми. Власник: controller (спільний договір web і engine).
-- Інші таблиці додають доріжки своїми міграціями (0002_auth для web тощо).

CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Людина. Акаунт народжується при першому вході поштою або через Telegram.
CREATE TABLE IF NOT EXISTS users (
    id                   TEXT PRIMARY KEY,                 -- uuid
    email                TEXT UNIQUE,                      -- нижній регістр
    telegram_id          TEXT UNIQUE,
    telegram_username    TEXT,
    channel              TEXT NOT NULL DEFAULT 'email' CHECK (channel IN ('email', 'telegram')),
    target_text          TEXT,                             -- «що шукаю» своїми словами
    roles                TEXT NOT NULL DEFAULT '[]',       -- JSON-масив ключів ролей (docs/contracts.md)
    remote_mode          TEXT,                             -- 'remote' | 'city' | 'remote,city'
    city                 TEXT,
    salary_min           INTEGER,
    salary_currency      TEXT,
    digest_hour          INTEGER NOT NULL DEFAULT 7,
    timezone             TEXT,
    visible_to_companies INTEGER NOT NULL DEFAULT 0,       -- вимкнено за замовчуванням
    contact_mode         TEXT NOT NULL DEFAULT 'approval' CHECK (contact_mode IN ('approval', 'direct')),
    onboarding_step      TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    last_active_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Підключені джерела. UNIQUE(kind, value): одна адреса чи нік належить одному акаунту.
CREATE TABLE IF NOT EXISTS identities (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('x', 'github', 'youtube', 'site', 'evm', 'solana')),
    value        TEXT NOT NULL,                             -- нормалізоване значення (docs/contracts.md)
    verified_via TEXT CHECK (verified_via IN ('bio_code', 'post_code', 'signature', 'oauth')),
    verified_at  TEXT,
    verify_code  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (kind, value)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);

-- Факти від джерела. gap_reason не NULL = прогалина (джерело не відповіло); це НЕ нуль.
CREATE TABLE IF NOT EXISTS source_facts (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source     TEXT NOT NULL CHECK (source IN ('x', 'github', 'evm', 'hyperliquid', 'solana', 'youtube', 'site')),
    facts_json TEXT,
    gap_reason TEXT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, source)
);

-- Бал по ролі. score NULL = роль не рахується (reason у breakdown_json).
CREATE TABLE IF NOT EXISTS scores (
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    score           REAL,
    core            REAL,
    cover           INTEGER,
    breakdown_json  TEXT NOT NULL,
    formula_version TEXT NOT NULL,
    computed_at     TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, role)
);

-- Черга рушія балу (engine на VPS забирає queued).
CREATE TABLE IF NOT EXISTS score_jobs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    reason      TEXT NOT NULL CHECK (reason IN ('connect', 'refresh', 'manual')),
    status      TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed')),
    attempts    INTEGER NOT NULL DEFAULT 0,
    error       TEXT,
    queued_at   TEXT NOT NULL DEFAULT (datetime('now')),
    started_at  TEXT,
    finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_score_jobs_status ON score_jobs(status, queued_at);

-- Прогони воріт якості.
CREATE TABLE IF NOT EXISTS quality_runs (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    formula_version TEXT NOT NULL,
    people          INTEGER NOT NULL,
    exact_pct       REAL NOT NULL,
    near_pct        REAL NOT NULL,
    unscored        INTEGER NOT NULL,
    report_json     TEXT NOT NULL,
    passed          INTEGER NOT NULL,
    run_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0001_core');
