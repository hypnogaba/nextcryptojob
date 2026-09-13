-- NextCryptoJob, доріжка web: оплата й агенти (доробки T9/T10 перед ключами CDP, docs/contracts.md §7).
-- Спирається на x402_payments з 0004_billing і audit_log з 0002_auth. Накочує controller, не доріжка,
-- і ДО деплою коду, що пише ці колонки.
-- Час: TEXT у форматі datetime('now'), UTC (договір §9).

-- «Paid without result» (специфікація CRM 7.4): гроші розраховано (status = 'settled'), а дія впала
-- після settle або її результат не записався. Окремі колонки, а не новий стан у CHECK колонки status:
-- CHECK у SQLite не змінити без перебудови таблиці, а DROP TABLE x402_payments зі ввімкненими
-- зовнішніми ключами обнулив би usage_events.x402_payment_id (ON DELETE SET NULL) у всіх рядках.
-- Рядок у списку адмінки: no_result_at IS NOT NULL; повернення грошей адмін робить руками поза сервісом
-- і позначає тут (refunded_*), з рядком audit_log.
ALTER TABLE x402_payments ADD COLUMN no_result_at TEXT;
ALTER TABLE x402_payments ADD COLUMN no_result_reason TEXT;              -- лише для адміна, клієнт не бачить
ALTER TABLE x402_payments ADD COLUMN refunded_at TEXT;
ALTER TABLE x402_payments ADD COLUMN refund_note TEXT;                   -- як і куди повернули (tx, дата)
ALTER TABLE x402_payments ADD COLUMN refunded_by TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_x402_no_result ON x402_payments(no_result_at DESC) WHERE no_result_at IS NOT NULL;

-- Ідемпотентний повтор оплаченого пошуку знаходить свій рядок журналу `candidate.search` за id
-- платежу одним індексом, а не переглядом усього журналу компанії (web/src/lib/crm/search.ts).
-- Лише індекс на таблиці 0002; meta_json цих рядків завжди пише JSON.stringify (lib/crm/audit.ts).
CREATE INDEX IF NOT EXISTS idx_audit_log_search_payment
    ON audit_log(json_extract(meta_json, '$.payment_id')) WHERE action = 'candidate.search';

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0016_x402_no_result');
