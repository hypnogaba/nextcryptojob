-- NextCryptoJob, база вакансій: ще п'ять ATS у реєстрі роботодавців (17.09.2026).
--
-- Розвідка 17.09 (jobs-discover --dry) показала 77 компаній дошок екосистем і фондів на ATS, яких скан
-- не читав. Додано ті, що мають публічний JSON: gem, pinpoint, hibob, comeet, workday
-- (engine/src/jobs/sources/ats.ts). SQLite не вміє міняти CHECK, тому таблицю перебудовано: ті самі
-- стовпці в тому самому порядку (0001 + 0004 + 0005), лише ширший список ats_provider.
-- Зовнішніх ключів на companies немає; індекси лише автоматичні (PRIMARY KEY і UNIQUE).

-- Залишок невдалого запуску не має зупиняти повтор. Перед накочуванням на прод: резервна копія companies.
DROP TABLE IF EXISTS companies_new;
CREATE TABLE companies_new (
    slug           TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    ats_provider   TEXT NOT NULL CHECK (ats_provider IN ('greenhouse', 'lever', 'lever_eu', 'ashby', 'workable',
                     'smartrecruiters', 'recruitee', 'teamtailor', 'breezy', 'bamboohr', 'rippling', 'personio',
                     'gem', 'pinpoint', 'hibob', 'comeet', 'workday')),
    ats_slug       TEXT NOT NULL,
    enabled        INTEGER NOT NULL DEFAULT 1,
    discovered_via TEXT NOT NULL,                   -- 'seed' | 'curated' | 'speedrun' | 'getro:<id>' | 'manual'
    note           TEXT,                            -- звідки відомо, що це саме та компанія
    added_at       TEXT NOT NULL DEFAULT (datetime('now')),
    domain         TEXT,
    about          TEXT,
    coingecko_id   TEXT,
    token_symbol   TEXT,
    token_confidence TEXT CHECK (token_confidence IN ('override', 'homepage', 'none')),
    token_checked_at TEXT,
    token_price_usd REAL,
    token_mcap_usd REAL,
    token_change_24h REAL,
    token_updated_at TEXT,
    UNIQUE (ats_provider, ats_slug)
);

INSERT INTO companies_new (slug, name, ats_provider, ats_slug, enabled, discovered_via, note, added_at, domain, about,
  coingecko_id, token_symbol, token_confidence, token_checked_at, token_price_usd, token_mcap_usd, token_change_24h, token_updated_at)
SELECT slug, name, ats_provider, ats_slug, enabled, discovered_via, note, added_at, domain, about,
  coingecko_id, token_symbol, token_confidence, token_checked_at, token_price_usd, token_mcap_usd, token_change_24h, token_updated_at
FROM companies;

DROP TABLE companies;
ALTER TABLE companies_new RENAME TO companies;

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0006_more_ats');
