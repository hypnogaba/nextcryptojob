-- NextCryptoJob, доріжка web: вхід, згоди, вебхук Telegram, журнал дій.
-- Спирається на users з 0001_core. Накочує controller, не доріжка.
-- Час у всіх стовпцях: формат SQLite 'YYYY-MM-DD HH:MM:SS', UTC (contracts §9).

-- Сесії входу (як у попередньому проєкті).
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,                    -- SHA-256 токена сесії (hex), сам токен у базу не пишемо
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  TEXT NOT NULL,                       -- SQLite format, UTC, see contracts §9
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Одноразові коди входу поштою. Сам код у базу не пишемо.
CREATE TABLE IF NOT EXISTS login_codes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    email       TEXT NOT NULL,                       -- нижній регістр
    code_hash   TEXT NOT NULL,                       -- HMAC-SHA256(SESSION_SECRET, email || ':' || code), hex
    expires_at  TEXT NOT NULL,                       -- SQLite format, UTC, see contracts §9
    attempts    INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    used_at     TEXT                                 -- SQLite format, UTC, see contracts §9
);
CREATE INDEX IF NOT EXISTS idx_login_codes_email ON login_codes(email);

-- Обмеження спроб входу (як у попередньому проєкті 0002).
CREATE TABLE IF NOT EXISTS auth_attempts (
    key           TEXT PRIMARY KEY,                  -- напр. 'login:<email>' або 'login-ip:<ip>'
    attempts      INTEGER NOT NULL DEFAULT 0,
    window_start  TEXT NOT NULL,                     -- SQLite format, UTC, see contracts §9
    blocked_until TEXT                               -- SQLite format, UTC, see contracts §9
);
CREATE INDEX IF NOT EXISTS idx_auth_attempts_window ON auth_attempts(window_start);

-- Згоди: поточний стан, один рядок на вид згоди.
-- kind без CHECK навмисно: перелік видів перевіряє код ('scoring', 'visibility',
-- 'contact', 'digest_email' на старті), і новий вид не вимагає перебудови таблиці.
-- Кожна зміна тут пишеться в consent_events у тій самій пакетній транзакції.
CREATE TABLE IF NOT EXISTS consents (
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    granted      INTEGER NOT NULL,
    text_version TEXT NOT NULL,
    at           TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, kind)
);

-- Історія згод, лише додавання (GDPR ст. 7(1): довести, на що й коли погодились).
-- Рядки не оновлюємо і не видаляємо; зникають лише разом з людиною (CASCADE).
CREATE TABLE IF NOT EXISTS consent_events (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    granted      INTEGER NOT NULL,
    text_version TEXT NOT NULL,
    at           TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_consent_events_user ON consent_events(user_id, at);

-- Побачені update_id вебхука Telegram: кожне оновлення обробляється один раз (як у попередньому проєкті).
CREATE TABLE IF NOT EXISTS webhook_updates (
    update_id INTEGER PRIMARY KEY,
    seen_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_webhook_updates_seen ON webhook_updates(seen_at);

-- Журнал дій: хто, що, над чим.
-- meta_json не містить персональних даних, окрім ідентифікаторів (жодних пошт,
-- ніків, адрес гаманців, текстів людини): журнал живе довше за самі дані.
CREATE TABLE IF NOT EXISTS audit_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    actor     TEXT,
    action    TEXT NOT NULL,
    target    TEXT,
    meta_json TEXT,
    at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log(target, at);
CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log(actor, at);

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0002_auth');
