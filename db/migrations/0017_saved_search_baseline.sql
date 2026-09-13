-- NextCryptoJob, доріжка web: збережені пошуки (T7; специфікація CRM 5.7, рішення рев'ю T7).
-- baseline_at: від якої миті рахувати «нових» кандидатів для щоденного сповіщення (cron T11):
-- створення пошуку або остання зміна фільтрів чи сортування. Нові = видимі кандидати під
-- фільтрами, чия видимість чи бал змінились після max(baseline_at, last_alert_at).
-- last_match_count = скільки було нових в останньому сповіщенні (NULL, доки сповіщення не було).
-- filter_changes / filter_changes_day: скільки разів за добу UTC змінено фільтри (не більше 10).
-- Спирається на saved_searches з 0003_crm. Накочує controller, не доріжка.

ALTER TABLE saved_searches ADD COLUMN baseline_at TEXT;
ALTER TABLE saved_searches ADD COLUMN filter_changes INTEGER NOT NULL DEFAULT 0;
ALTER TABLE saved_searches ADD COLUMN filter_changes_day TEXT;

UPDATE saved_searches SET baseline_at = created_at WHERE baseline_at IS NULL;

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0017_saved_search_baseline');
