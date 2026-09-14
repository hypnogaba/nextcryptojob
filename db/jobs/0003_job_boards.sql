-- NextCryptoJob, база вакансій: реєстр дошок екосистем і фондів (14.09.2026).
--
-- Рядок = одна дошка вакансій екосистеми (Solana, Arbitrum…) чи фонду (Multicoin, Dragonfly…), з
-- платформою й рішенням. Джерело правди db/jobs/seed/boards.json, рядки накочує
-- db/jobs/seed/update-2026-09-14-boards.sql (engine: scripts/jobs-seed.ts boards).
--
-- Що з рядком робить engine:
--   decision 'discover' (лише platform 'getro'): щотижнева розвідка (jobs-discover, JOBS_GETRO_DISCOVERY=1)
--     читає список компаній дошки, а для компанії з вакансіями, якої реєстр не знає, одну сторінку її
--     вакансій, звідки бере лише адресу ATS чи сторінки кар'єри, і додає нових роботодавців у companies.
--     Вакансій і текстів Getro в jobs_cache немає; щоденний скан Getro не читає.
--   decision 'manual': дошка на платформі, що забороняє збір (Consider); роботодавців портфеля додано
--     руками з публічної сторінки портфеля фонду (companies.discovered_via = 'portfolio:<slug>').
--   decision 'skip': не читаємо (причина в reason).
-- Таблиця getro_collections (0001) лишається, але розвідка її більше не читає: її замінила job_boards.
--
-- Без вторинних індексів: рядків кілька десятків, пишуться руками й доповненнями, читає лише розвідка.
CREATE TABLE IF NOT EXISTS job_boards (
    slug         TEXT PRIMARY KEY,
    label        TEXT NOT NULL,
    kind         TEXT NOT NULL CHECK (kind IN ('ecosystem', 'fund', 'association')),
    url          TEXT,                                -- дошка; для 'manual' сторінка портфеля
    platform     TEXT NOT NULL CHECK (platform IN ('getro', 'consider', 'pallet', 'custom', 'ats', 'none')),
    platform_id  TEXT,                                -- Getro: номер колекції (network.id сторінки дошки)
    companies    INTEGER,                             -- скільки компаній показувала дошка на checked_at
    decision     TEXT NOT NULL CHECK (decision IN ('discover', 'skip', 'manual')),
    -- all: кожна організація дошки крипто (екосистема, крипто-фонд); tagged: та, кого Getro називає
    -- крипто галуззю, або без галузі (фонд, що інвестує й поза криптою); strict: лише названа крипто
    -- (фонд, де крипто меншість, як ігровий Bitkraft).
    crypto_scope TEXT NOT NULL DEFAULT 'all' CHECK (crypto_scope IN ('all', 'tagged', 'strict')),
    reason       TEXT,
    checked_at   TEXT,                                -- коли сторінку дошки перевірено (YYYY-MM-DD)
    added_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0003_job_boards');
