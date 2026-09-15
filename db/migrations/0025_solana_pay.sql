-- NextCryptoJob, п.8 (раунд 5, 15.09, РІШЕННЯ ВЛАСНИКА: лише Solana, Stripe не потрібен).
--
-- Solana Pay: компанія платить 100 USDC на 30 днів зі свого гаманця (QR чи посилання), без ключів
-- на нашому боці (лише публічна адреса отримувача, env NCJ_PAY_ADDRESS). Один рядок на спробу:
-- `reference` — одноразовий публічний ключ, який гаманець платника кладе в транзакцію як звичайний
-- (не signer) обліковий запис, тож ми знаходимо платіж через getSignaturesForAddress(reference), а не
-- вгадуємо його серед усіх транзакцій на адресу отримувача (chain, lib/billing/solana-pay.ts).
-- Підтверджений рахунок дає новий рядок subscriptions (provider='usdc', як buyUsdcMonth x402,
-- lib/billing/usdc.ts): один платіж, один спосіб оплати USDC для компанії, білінг і адмінка не
-- розрізняють, звідки прийшли гроші.
--
-- reminded_at на subscriptions: нагадування за 3 дні до кінця конкретного оплаченого періоду
-- (провайдер 'usdc', і x402, і Solana Pay), щоб не надсилати його двічі за той самий рядок.
--
-- x402_payments.svm_transaction: другий UNIQUE для Solana, як evm_from/evm_nonce для EVM (0004_billing,
-- lib/x402/server.ts paymentPayloadHash): payload_hash ловить точний повтор запиту, але лишає повторний
-- платіж дійсним, якщо клієнт передав той самий payload.transaction із зайвим сусіднім ключем чи іншим
-- порядком полів обгортки, — а лише Solana тепер (п.8) означає, що це єдина мережа, яку варто цим
-- покрити. NULL для EVM-платежів (їх уже нема, лишились у базі, якщо колись були).
--
-- Номер 0025: 0024 лишений іншій доріжці цієї ж пачки. Накочує controller, ДО деплою коду; локально
-- перевірено на sqlite (SqliteD1). Код без цієї міграції: створення рахунку Solana Pay ловить
-- "no such table" і каже, що недоступно, решта білінгу (Stripe, x402) як була.

CREATE TABLE IF NOT EXISTS solana_pay_invoices (
    id              TEXT PRIMARY KEY,                                  -- 'spi_…'
    company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    reference       TEXT NOT NULL UNIQUE,                               -- base58, лише мітка для пошуку в мережі
    amount_usdc     INTEGER NOT NULL DEFAULT 100,
    status          TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'expired')) DEFAULT 'pending',
    tx              TEXT,                                               -- підпис транзакції, коли confirmed
    payer           TEXT,                                               -- адреса платника (ATA власника, postTokenBalances)
    subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
    created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    confirmed_at    TEXT,
    expires_at      TEXT NOT NULL                                       -- pending довше цього не перевіряємо, лише 'expired'
);
CREATE INDEX IF NOT EXISTS idx_solana_pay_company ON solana_pay_invoices(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_solana_pay_pending ON solana_pay_invoices(status, expires_at) WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS uq_solana_pay_tx ON solana_pay_invoices(tx) WHERE tx IS NOT NULL;

ALTER TABLE subscriptions ADD COLUMN reminded_at TEXT;

ALTER TABLE x402_payments ADD COLUMN svm_transaction TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_x402_svm_transaction ON x402_payments(network, svm_transaction)
    WHERE svm_transaction IS NOT NULL;

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0025_solana_pay');
