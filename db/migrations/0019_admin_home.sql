-- NextCryptoJob, доріжка web: головна адмінки (/admin) і налаштування (/admin/settings).
-- Спирається на users з 0001_core і digest_runs з 0006_digest. Накочує controller, не доріжка,
-- і ДО деплою коду, що пише ці таблиці (без них код працює, але історії cron і налаштувань немає).
-- Час: TEXT у форматі datetime('now'), UTC (договір §9).

-- Журнал запусків cron (web/src/lib/cron/index.ts, runCron): рядок на кожну задачу кожного
-- запуску. Досі був лише рядок JSON у журналі Worker, а адмінці треба бачити останній запуск
-- і чи він вдався. counts_json = лічильники задачі (без персональних даних), error = причина
-- збою. Живе 30 днів: старше прибирає щоденне прибирання (web/src/lib/cron/cleanup.ts).
-- Близько 650 рядків на добу (2 задачі кожні 5 хв, 3 щогодини, 1 щодня).
CREATE TABLE IF NOT EXISTS cron_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    job         TEXT NOT NULL,                  -- назва задачі: 'intros.expire', 'cleanup.daily', ...
    cron        TEXT NOT NULL,                  -- рядок тригера: '*/5 * * * *'
    started_at  TEXT NOT NULL,
    ms          INTEGER NOT NULL,
    ok          INTEGER NOT NULL CHECK (ok IN (0, 1)),
    counts_json TEXT,
    error       TEXT
);
-- Останній запуск кожної задачі одним кроком індексу (адмінка) і збої задачі за добу.
CREATE INDEX IF NOT EXISTS idx_cron_runs_job ON cron_runs(job, started_at DESC);

-- Налаштування, які адмін міняє без деплою (web/src/lib/admin/settings.ts, типований реєстр).
-- Рядка немає = значення за замовчуванням з реєстру. Лише безпечні ключі, які web виконує
-- одразу; ключ поза реєстром код ігнорує. Кожна зміна пише audit_log.
CREATE TABLE IF NOT EXISTS app_settings (
    key        TEXT PRIMARY KEY,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_by TEXT REFERENCES users(id) ON DELETE SET NULL
);

-- Добірки за останні 7 днів на головній адмінки: діапазон індексом, а не прохід по всій
-- digest_runs (рядок на людину на день). Лише індекс на таблиці engine, без нових колонок.
CREATE INDEX IF NOT EXISTS idx_digest_runs_created ON digest_runs(created_at);

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0019_admin_home');
