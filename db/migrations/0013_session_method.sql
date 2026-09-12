-- NextCryptoJob, доріжка web: доробки Telegram (W3b, docs/contracts.md).
-- Чим людина ввійшла в цю сесію: 'email' (код з листа) або 'telegram' (OIDC).
-- Адмінка пускає лише сесію, відкриту поштою. Старі сесії лишаються з NULL і
-- адмінами не вважаються: адмін один раз входить поштою заново.
-- Спирається на sessions з 0002_auth. Накочує controller, не доріжка, і ДО
-- деплою коду W3b: код пише й читає sessions.method.

ALTER TABLE sessions ADD COLUMN method TEXT CHECK (method IN ('email', 'telegram'));

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0013_session_method');
