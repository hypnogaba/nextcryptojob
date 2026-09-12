-- NextCryptoJob, доріжка web: налаштування (docs/contracts.md, розділ 7).
-- Пауза щоденних вакансій: канал, година й пояс лишаються, але добірка не йде, доки
-- людина не зніме паузу. Рушій добірки (0006_digest) пропускає digest_paused = 1.
-- Спирається на users з 0001_core. Накочує controller, не доріжка.

ALTER TABLE users ADD COLUMN digest_paused INTEGER NOT NULL DEFAULT 0;

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0011_user_settings');
