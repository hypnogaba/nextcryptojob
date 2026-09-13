-- NextCryptoJob, доріжка web: перехід "Apply" з публічної сторінки вакансії (T12, рев'ю).
-- Один відвідувач рахується в company_jobs.apply_clicks не частіше за раз на вакансію за
-- 10 хвилин. Рядок на пару (відвідувач, вакансія): key = HMAC-SHA-256 від IP і id вакансії,
-- IP як є не зберігається. Rate Limiting Workers цього не вміє (період лише 10 або 60 с),
-- KV у проєкті немає. Прострочені рядки (seen_at старше 10 хв) прибирає сам перехід, по
-- кілька за раз індексом idx_apply_click_seen_at (web/src/lib/crm/public-jobs.ts).
-- Незалежна від решти таблиць. Накочує controller, не доріжка.

CREATE TABLE IF NOT EXISTS apply_click_seen (
    key     TEXT PRIMARY KEY,
    seen_at TEXT NOT NULL            -- UTC, формат datetime('now')
);
CREATE INDEX IF NOT EXISTS idx_apply_click_seen_at ON apply_click_seen(seen_at);

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0018_apply_click_seen');
