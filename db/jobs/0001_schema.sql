-- NextCryptoJob, база вакансій (D1 `nextcryptojob-jobs`). Окрема від основної бази `nextcryptojob`
-- (db/migrations) і від будь-якої бази попереднього проєкту: пише сюди лише сканер engine (engine/src/jobs),
-- сайт і добірка лише читають. Нумерація своя, від 0001.
--
-- Ціни D1: запис $1 за мільйон рядків, читання $0.001 за мільйон. Рахунок роблять записи, а
-- запис рахується в таблицю й у КОЖЕН індекс, чий стовпець змінився. Тому:
--   - jobs_cache без жодного вторинного індексу: скан щодня переписує fetched_at у кожної
--     побаченої вакансії, і індекс з ним подвоював би записи. Читання пулу це повний прохід,
--     але база лише крипто (тисячі рядків, а не десятки тисяч), і сайт тримає пул у пам'яті.
--   - WITHOUT ROWID: первинний ключ і є таблицею, окремого автоіндексу на id немає. id виводиться
--     з адреси (engine/src/jobs/ids.ts), тож окремий UNIQUE на url теж не потрібен.
--   - стан джерел пишеться лише при зміні (збій, одужання), а не щоскану.
-- Час: ISO з 'T' і 'Z' (як пише сканер), крім DEFAULT datetime('now') у довідниках.

CREATE TABLE IF NOT EXISTS schema_migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Вакансії. Назва й стовпці ті самі, що читають сайт (web/src/lib/jobs, web/src/lib/admin/job-sources.ts,
-- web/src/lib/digest/history.ts) і добірка (engine/src/digest/jobs.ts): їхні запити не міняються.
CREATE TABLE IF NOT EXISTS jobs_cache (
    id              TEXT PRIMARY KEY,               -- 'j' + 24 hex від sha256(url): та сама адреса = той самий id
    url             TEXT NOT NULL,                  -- куди йде людина (посилання джерела як є)
    company         TEXT NOT NULL,
    company_key     TEXT NOT NULL,                  -- engine/src/digest/clean.ts companyKey
    title           TEXT NOT NULL,
    location        TEXT,
    remote          INTEGER NOT NULL DEFAULT 0,
    salary_min      INTEGER,                        -- завжди річна сума (engine/src/jobs/pay.ts)
    salary_max      INTEGER,
    salary_currency TEXT,                           -- ISO 4217
    source          TEXT NOT NULL,                  -- '<ats>:<slug>' | 'board:<name>' | 'aggregator:<name>'
    tags            TEXT NOT NULL DEFAULT '["web3"]', -- JSON; 'web3' є завжди, плюс сфера з назви і 'remote'
    dedupe_key      TEXT NOT NULL,                  -- компанія|назва без шуму: та сама вакансія під іншою адресою
    posted_at       TEXT,                           -- дата джерела; NULL, якщо джерело її не дає
    fetched_at      TEXT NOT NULL,                  -- коли скан бачив вакансію востаннє (живе = за 3 доби)
    first_seen_at   TEXT NOT NULL,                  -- коли скан побачив її вперше (не переписується)
    country         TEXT                            -- «лише для цієї країни»; для крипто-джерел NULL
) WITHOUT ROWID;

-- Роботодавці з публічним ATS. Засів: db/jobs/seed (разовий експорт публічних даних, 14.09.2026),
-- далі щотижнева розвідка (engine jobs-discover) і руками.
CREATE TABLE IF NOT EXISTS companies (
    slug           TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    ats_provider   TEXT NOT NULL CHECK (ats_provider IN ('greenhouse', 'lever', 'lever_eu', 'ashby', 'workable',
                     'smartrecruiters', 'recruitee', 'teamtailor', 'breezy', 'bamboohr', 'rippling', 'personio')),
    ats_slug       TEXT NOT NULL,
    enabled        INTEGER NOT NULL DEFAULT 1,
    discovered_via TEXT NOT NULL,                   -- 'seed' | 'curated' | 'speedrun' | 'getro:<id>' | 'manual'
    note           TEXT,                            -- звідки відомо, що це саме та компанія
    added_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (ats_provider, ats_slug)
);

-- Джерела поза ATS: дошки й агрегатори, лише крипто. Вимкнене не читається.
CREATE TABLE IF NOT EXISTS sources (
    name       TEXT PRIMARY KEY,                    -- 'board:web3career', 'aggregator:speedrun'
    label      TEXT NOT NULL,
    kind       TEXT NOT NULL CHECK (kind IN ('jsonld', 'nextjs', 'rss', 'speedrun')),
    feed_url   TEXT NOT NULL,
    site_url   TEXT,
    -- 1: кожна вакансія крипто (web3.career, remote3); 0: лише ті, що дошка сама позначила крипто (JobStash).
    crypto_only INTEGER NOT NULL DEFAULT 1,
    enabled    INTEGER NOT NULL DEFAULT 1,
    terms_note TEXT,                                -- рішення про умови джерела (engine/deploy/README.md)
    added_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Здоров'я джерела (ATS компанії, дошка, агрегатор). Рядок пишеться лише при зміні: перший збій,
-- новий день збою, одужання. Здорове джерело без рядка = ok; його останній день видно з
-- MAX(jobs_cache.fetched_at). dead (DEAD_AFTER_DAYS днів поспіль) щодня не читається, лише раз на тиждень.
CREATE TABLE IF NOT EXISTS source_state (
    source     TEXT PRIMARY KEY,
    status     TEXT NOT NULL CHECK (status IN ('failing', 'dead')),
    fail_days  INTEGER NOT NULL DEFAULT 1,
    last_error TEXT,
    failed_at  TEXT NOT NULL,                       -- останній день збою (ISO)
    checked_at TEXT NOT NULL                        -- остання спроба (для щотижневої перевірки dead)
);

-- Колекції Getro для щотижневої розвідки посилань на ATS. Читаються лише з JOBS_GETRO_DISCOVERY=1
-- (типово вимкнено: умови Getro, engine/deploy/README.md). Вакансій з Getro у jobs_cache немає.
CREATE TABLE IF NOT EXISTS getro_collections (
    collection_id INTEGER PRIMARY KEY,
    label         TEXT NOT NULL,
    url           TEXT,
    enabled       INTEGER NOT NULL DEFAULT 1,
    added_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Прогони команд engine: jobs-scan, jobs-discover, jobs-prune. Два записи на прогін.
CREATE TABLE IF NOT EXISTS scan_runs (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL DEFAULT 'scan' CHECK (kind IN ('scan', 'discover', 'prune')),
    started_at    TEXT NOT NULL,
    finished_at   TEXT,
    status        TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'partial', 'failed')),
    sources_ok    INTEGER NOT NULL DEFAULT 0,
    sources_failed INTEGER NOT NULL DEFAULT 0,
    jobs_found    INTEGER NOT NULL DEFAULT 0,       -- після вікна й дедупу
    jobs_new      INTEGER NOT NULL DEFAULT 0,       -- з них нових адрес
    rows_written  INTEGER,                          -- meta.rows_written від D1, сума за прогін
    notes         TEXT                              -- JSON: підсумок по джерелах
);
-- «Останній скан» в адмінці: ORDER BY started_at DESC LIMIT 1 за видом. Два записи на прогін.
CREATE INDEX IF NOT EXISTS idx_scan_runs_kind_started ON scan_runs(kind, started_at);

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0001_schema');
