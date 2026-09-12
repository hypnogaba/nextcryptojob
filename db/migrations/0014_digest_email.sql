-- NextCryptoJob, доріжка web: лист добірки (W7, docs/contracts.md, розділ 7).
-- Спирається на digest_runs з 0006_digest. Накочує controller, не доріжка.
-- Час: TEXT у форматі datetime('now'), UTC (договір §9).

-- Ідемпотентність POST /api/internal/digest-email за digest_id (engine/src/digest/README.md):
-- engine повторює запит після мережевого збою чи 5xx, і другий лист піти не має. Рядок
-- тут, а не в пам'яті Worker, бо повтор може прийти в інший ізолят.
-- status: sending (лист у дорозі), sent, failed (поштовий сервіс відмовив; повтор може
-- забрати рядок знову). Адреси й тексту листа тут немає: лише стан і код помилки сервісу.
-- Людина зникає разом з digest_runs (каскад з users), тож окремого user_id не треба.
CREATE TABLE IF NOT EXISTS digest_emails (
    digest_id  TEXT PRIMARY KEY REFERENCES digest_runs(id) ON DELETE CASCADE,
    status     TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
    attempts   INTEGER NOT NULL DEFAULT 1,
    error      TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0014_digest_email');
