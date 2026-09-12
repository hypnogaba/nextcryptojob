-- NextCryptoJob, оплата й агенти. Власник: web (оплата й агенти). Перелік таблиць: docs/contracts.md §7.
-- Специфікація: docs/specs/2026-09-12-crm-agents-design.md (розділи 7 і 8).
-- Залежить від 0003_crm (companies, company_jobs).
-- Час: UTC у форматі datetime('now'). Публічні id: sub_, key_, pay_.

-- Підписка компанії. Рядок на кожен екземпляр підписки; чинна та, що дає доступ
-- (подання company_access нижче). Джерело правди для provider='stripe' це Stripe:
-- на кожну подію вебхука робимо subscriptions.retrieve і перезаписуємо рядок цілком.
CREATE TABLE IF NOT EXISTS subscriptions (
    id                     TEXT PRIMARY KEY,                    -- 'sub_…' (наш id, не Stripe)
    company_id             TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    provider               TEXT NOT NULL CHECK (provider IN ('stripe', 'usdc', 'manual')),
    plan                   TEXT NOT NULL DEFAULT 'company_monthly',
    status                 TEXT NOT NULL CHECK (status IN (
                               'incomplete', 'incomplete_expired', 'trialing', 'active',
                               'past_due', 'unpaid', 'paused', 'canceled')),
    current_period_start   TEXT,                                -- Stripe: items.data[0].current_period_start
    current_period_end     TEXT,                                -- доступ до цієї миті (usdc/manual: головне поле)
    trial_end              TEXT,
    cancel_at              TEXT,                                -- заплановане скасування (flexible billing)
    canceled_at            TEXT,
    stripe_customer_id     TEXT,
    stripe_subscription_id TEXT UNIQUE,
    stripe_price_id        TEXT,
    currency               TEXT,                                -- 'usd' | 'eur' | 'usdc'
    amount_cents           INTEGER,                             -- сума за період без податку
    last_x402_payment_id   TEXT,                                -- provider='usdc': платіж за останній місяць
    granted_by             TEXT REFERENCES users(id) ON DELETE SET NULL,  -- provider='manual'
    note                   TEXT,                                -- причина ручного доступу
    stripe_synced_at       TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at             TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (provider <> 'stripe' OR stripe_subscription_id IS NOT NULL),
    CHECK (provider = 'stripe' OR current_period_end IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_subscriptions_company ON subscriptions(company_id, current_period_end DESC);
CREATE INDEX IF NOT EXISTS idx_subscriptions_customer ON subscriptions(stripe_customer_id);

-- Ключ API: 'ncj_live_' + 32 випадкові байти в base62. Зберігаємо лише SHA-256 (hex);
-- сам ключ показуємо один раз. Створює лише власник компанії.
CREATE TABLE IF NOT EXISTS api_keys (
    id                 TEXT PRIMARY KEY,                        -- 'key_…'
    company_id         TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name               TEXT NOT NULL,                           -- до 60 символів
    prefix             TEXT NOT NULL,                           -- перші 16 символів ключа, для показу
    key_hash           TEXT NOT NULL UNIQUE,
    created_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    last_used_at       TEXT,                                    -- оновлюємо не частіше 1 разу на 5 хв
    revoked_at         TEXT,
    revoked_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_api_keys_company ON api_keys(company_id, revoked_at);

-- Платіж x402. payload_hash (SHA-256 декодованого PaymentPayload) унікальний: один
-- підписаний платіж оплачує рівно один запит, повтор тіла дає 409 payment_reused.
-- Рядки лишаються після закриття компанії (бухгалтерія), тому company_id SET NULL.
CREATE TABLE IF NOT EXISTS x402_payments (
    id                 TEXT PRIMARY KEY,                        -- 'pay_…'
    payload_hash       TEXT NOT NULL UNIQUE,
    payment_identifier TEXT UNIQUE,                             -- розширення payment-identifier, якщо клієнт дав
    company_id         TEXT REFERENCES companies(id) ON DELETE SET NULL,
    api_key_id         TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
    payer              TEXT,                                    -- адреса платника з verify
    network            TEXT NOT NULL,                           -- CAIP-2: 'eip155:8453', 'solana:5eykt…'
    asset              TEXT NOT NULL,                           -- адреса контракту або mint USDC
    pay_to             TEXT NOT NULL,
    amount_atomic      TEXT NOT NULL,                           -- рядок в атомарних одиницях (USDC: 6 знаків)
    amount_usd_cents   INTEGER NOT NULL,
    action             TEXT NOT NULL CHECK (action IN ('search_candidates', 'request_intro', 'buy_usdc_month')),
    channel            TEXT NOT NULL CHECK (channel IN ('rest', 'mcp')),
    status             TEXT NOT NULL CHECK (status IN ('verified', 'settled', 'failed')),
    tx                 TEXT,                                    -- хеш або підпис транзакції після settle
    error_reason       TEXT,
    facilitator        TEXT NOT NULL CHECK (facilitator IN ('cdp', 'payai', 'x402org')),
    request_id         TEXT,
    created_at         TEXT NOT NULL DEFAULT (datetime('now')),
    settled_at         TEXT
);
CREATE INDEX IF NOT EXISTS idx_x402_company ON x402_payments(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_x402_payer ON x402_payments(payer, action, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS uq_x402_tx ON x402_payments(network, tx) WHERE tx IS NOT NULL;

-- Облік викликів: денні квоти, сторінка «Usage», підсумки для адмінки.
-- Пишемо рядок на кожен виклик з відомим актором (ключ, сесія члена команди або платник x402).
-- Зберігаємо 400 днів (cron чистить старші).
CREATE TABLE IF NOT EXISTS usage_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    company_id      TEXT REFERENCES companies(id) ON DELETE CASCADE,
    api_key_id      TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
    member_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
    payer           TEXT,                                       -- гість x402 без ключа
    channel         TEXT NOT NULL CHECK (channel IN ('web', 'rest', 'mcp')),
    action          TEXT NOT NULL,                              -- назва дії з реєстру (специфікація, розділ 6.2)
    billing         TEXT NOT NULL CHECK (billing IN ('included', 'x402', 'free')),
    x402_payment_id TEXT REFERENCES x402_payments(id) ON DELETE SET NULL,
    status          INTEGER NOT NULL,                           -- HTTP-код відповіді
    results         INTEGER,                                    -- скільки кандидатів повернуто
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_usage_company_action ON usage_events(company_id, action, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_key ON usage_events(api_key_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_payer ON usage_events(payer, action, created_at) WHERE payer IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_events(created_at);

-- Хто має доступ до CRM зараз. Одне правило для web, REST, MCP і engine.
-- Stripe: 2 доби запасу на запізнілий вебхук продовження; past_due: 7 діб пільги.
CREATE VIEW IF NOT EXISTS company_access AS
SELECT c.id AS company_id,
       CASE
         WHEN c.status <> 'active' THEN 'none'
         WHEN EXISTS (
           SELECT 1 FROM subscriptions s
           WHERE s.company_id = c.id
             AND s.status IN ('trialing', 'active')
             AND (s.current_period_end IS NULL
                  OR datetime(s.current_period_end,
                              CASE s.provider WHEN 'stripe' THEN '+2 days' ELSE '+0 days' END) > datetime('now'))
         ) THEN 'subscription'
         WHEN EXISTS (
           SELECT 1 FROM subscriptions s
           WHERE s.company_id = c.id AND s.status = 'past_due'
             AND datetime(s.current_period_end, '+7 days') > datetime('now')
         ) THEN 'subscription'
         ELSE 'pay_per_request'
       END AS access,
       (SELECT s.status FROM subscriptions s WHERE s.company_id = c.id
         ORDER BY s.created_at DESC LIMIT 1) AS latest_status
FROM companies c;

-- Живі вакансії компаній для рушія добірки (0006_digest) і публічного search_jobs.
-- Лише відкриті, не приховані адміном, не прострочені, у компаній з підпискою.
CREATE VIEW IF NOT EXISTS company_jobs_live AS
SELECT j.id, j.company_id, j.title, j.description, j.roles, j.remote_mode, j.city, j.country,
       j.salary_min, j.salary_max, j.salary_currency, j.salary_period, j.apply_url, j.tags,
       j.published_at, j.expires_at,
       c.name AS company_name, c.domain AS company_domain,
       (c.domain_verified_at IS NOT NULL) AS company_domain_verified
FROM company_jobs j
JOIN companies c ON c.id = j.company_id
JOIN company_access a ON a.company_id = c.id
WHERE j.status = 'open'
  AND j.hidden_by_admin_at IS NULL
  AND j.expires_at > datetime('now')
  AND a.access = 'subscription';

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0004_billing');
