-- NextCryptoJob, доріжка web: інструменти власника (адмінка). Власний лічильник відвідувань,
-- сповіщення власнику з дедуплікацією, демо-компанія для перевірки CRM.
-- Спирається на users (0001), companies (0003), company_access і company_jobs_live (0012).
-- Накочує controller, ДО деплою коду: код читає users.is_demo і companies.is_demo у кожному
-- пошуку кандидатів (правило видимості, web/src/lib/crm/visibility.ts).
-- Час: TEXT у форматі datetime('now'), UTC (договір §9); день: 'YYYY-MM-DD' UTC.
--
-- Ціна записів D1 ($1 за мільйон рядків понад 50 млн на місяць у тарифі Workers Paid):
--   перегляд сторінки = 1 рядок visit_days (UPSERT, таблиця без ROWID і без індексів)
--   + 1 рядок visit_visitors лише для першого перегляду відвідувача за день (повтор нічого не пише).
--   10 тис. переглядів на день ≈ 12 тис. рядків ≈ 0,36 млн на місяць, тобто в межах включених.

-- Відвідування за день: переглядів і нових за день відвідувачів, за групою сторінок і хостом,
-- звідки прийшли. Сирих адрес сторінок, IP й агентів тут немає.
--   path_group: 'home', 'jobs', 'card', 'company', 'login', 'onboarding', 'profile', ... (lib/analytics/visits.ts)
--   ref_host:   '' = перехід усередині сайту, 'direct' = без referrer, інакше хост без 'www.'.
-- uniques: відвідувач уперше за цей день (visit_visitors), записаний на рядок першого перегляду.
CREATE TABLE IF NOT EXISTS visit_days (
    day        TEXT NOT NULL,
    path_group TEXT NOT NULL,
    ref_host   TEXT NOT NULL,
    views      INTEGER NOT NULL DEFAULT 0,
    uniques    INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (day, path_group, ref_host)
) WITHOUT ROWID;

-- Хто вже був сьогодні: hex SHA-256 від (сіль дня, IP, User-Agent), перші 32 символи. Сіль дня
-- виводиться з секрету Worker і дати, сам IP і агент не зберігаються ніде. Рядки старші за
-- вчора стирає щоденне прибирання (web/src/lib/cron/cleanup.ts): після цього відвідувача
-- не впізнати навіть із секретом.
CREATE TABLE IF NOT EXISTS visit_visitors (
    day  TEXT NOT NULL,
    hash TEXT NOT NULL,
    PRIMARY KEY (day, hash)
) WITHOUT ROWID;

-- Сповіщення власнику (web/src/lib/admin/alerts.ts) і щотижневий звіт: одне й те саме
-- сповіщення (key) не частіше за його вікно (типово 24 год). Рядок живе 60 днів.
--   key:     'agency:app_…', 'scan:failed', 'source:greenhouse:acme', 'cron:jobs.expire', 'weekly:2026-09-14'
--   summary: короткий текст без персональних даних (для списку в адмінці).
CREATE TABLE IF NOT EXISTS owner_alerts (
    key      TEXT PRIMARY KEY,
    kind     TEXT NOT NULL,
    sent_at  TEXT NOT NULL,
    times    INTEGER NOT NULL DEFAULT 1,
    summary  TEXT,
    channel  TEXT,                              -- 'telegram', 'email', 'telegram,email' або NULL (не дійшло)
    error    TEXT
) WITHOUT ROWID;

-- Демо: синтетичні кандидати й демо-компанія для перевірки CRM (web/src/lib/admin/demo.ts).
-- Демо-кандидата бачить лише демо-компанія, реальну людину демо-компанія не бачить
-- (правило видимості). Демо не рахується в аналітиці й не отримує добірок.
ALTER TABLE users ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
ALTER TABLE companies ADD COLUMN is_demo INTEGER NOT NULL DEFAULT 0;
-- Часткові індекси: пишуться лише для демо-рядків, реальних записів не дорожчають.
CREATE INDEX IF NOT EXISTS idx_users_demo ON users(id) WHERE is_demo = 1;
CREATE INDEX IF NOT EXISTS idx_companies_demo ON companies(id) WHERE is_demo = 1;

-- Вакансії демо-компанії не йдуть ні в добірку, ні в публічний пошук вакансій.
-- Те саме подання, що в 0012, плюс умова c.is_demo = 0.
DROP VIEW IF EXISTS company_jobs_live;
CREATE VIEW company_jobs_live AS
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
  AND a.access = 'subscription'
  AND c.is_demo = 0;

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0020_owner_tools');
