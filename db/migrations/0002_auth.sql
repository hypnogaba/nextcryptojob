-- NextCryptoJob, доріжка web: вхід, згоди, вебхук Telegram, журнал дій.
-- Спирається на users з 0001_core. Накочує controller, не доріжка.

-- Сесії входу (як у NextRole).
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Одноразові коди входу поштою. Зберігаємо лише хеш коду.
CREATE TABLE IF NOT EXISTS login_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT NOT NULL,                       -- нижній регістр
    code_hash   TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    used_at     TEXT
);
CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email);

-- Обмеження спроб входу (як у NextRole 0002).
CREATE TABLE IF NOT EXISTS auth_attempts (
    key           TEXT PRIMARY KEY,                  -- напр. 'login:<email>' або 'login-ip:<ip>'
    attempts      INTEGER NOT NULL DEFAULT 0,
    window_start  TEXT NOT NULL,
    blocked_until TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_window ON auth_attempts(window_start);

-- Згоди людини. Один рядок на вид згоди; text_version = версія тексту, на який погодились.
CREATE TABLE IF NOT EXISTS consents (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('scoring', 'visibility', 'contact', 'digest_email')),
    granted      INTEGER NOT NULL,
    text_version TEXT NOT NULL,
    at           TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, kind)
);

-- Побачені update_id вебхука Telegram: кожне оновлення обробляється один раз (як у NextRole).
CREATE TABLE IF NOT EXISTS webhook_updates (
    update_id INTEGER PRIMARY KEY,
    seen_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_updates_seen ON webhook_updates(seen_at);

-- Журнал дій: хто, що, над чим.
CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    actor     TEXT,
    action    TEXT NOT NULL,
    target    TEXT,
    meta_json TEXT,
    at        TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0002_auth');
