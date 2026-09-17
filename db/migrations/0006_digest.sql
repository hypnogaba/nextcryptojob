-- NextCryptoJob, доріжка engine: щоденна добірка вакансій (docs/contracts.md, розділ 7).
-- Спирається на users з 0001_core. Накочує controller, не доріжка.
-- Час: TEXT у форматі datetime('now'), UTC (договір §9).

-- Що кому показано. Один рядок на пару (людина, вакансія): UNIQUE не дає надіслати ту саму
-- вакансію двічі, навіть якщо рядок 'failed'. job_ref: 'nr:<jobs_cache.id>' (кеш попереднього проєкту,
-- інша база D1, тому без FK) або 'co:<company_jobs.id>' (вакансія компанії, 0003).
CREATE TABLE IF NOT EXISTS sent (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_ref    TEXT NOT NULL,
    source     TEXT NOT NULL CHECK (source IN ('nextrole', 'company')),
    digest_id  TEXT NOT NULL,                              -- digest_runs.id
    position   INTEGER NOT NULL,                           -- 1..5 у добірці
    status     TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
    channel    TEXT CHECK (channel IN ('telegram', 'email')),
    why        TEXT,                                       -- рядок «чому ця вакансія» (англійською)
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    sent_at    TEXT,
    UNIQUE (user_id, job_ref)
);
CREATE INDEX IF NOT EXISTS idx_sent_user ON sent(user_id, created_at);
-- Оновлення статусів після доставки йде за digest_id.
CREATE INDEX IF NOT EXISTS idx_sent_digest ON sent(digest_id);

-- Один прогін добірки на людину на її дату (у її поясі). UNIQUE робить щогодинний
-- таймер ідемпотентним: друга спроба того самого дня впирається в нього.
-- status: pending (записано, ще не доставлено), sent, failed, empty (нічого не підійшло).
CREATE TABLE IF NOT EXISTS digest_runs (
    id          TEXT PRIMARY KEY,                          -- 'dg_<uuid>'
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    local_date  TEXT NOT NULL,                             -- YYYY-MM-DD у поясі людини
    status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'empty')),
    jobs        INTEGER NOT NULL DEFAULT 0,
    channel     TEXT CHECK (channel IN ('telegram', 'email')),
    error       TEXT,                                      -- причина failed або примітка (напр. лист замість Telegram)
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    finished_at TEXT,
    UNIQUE (user_id, local_date)
);
-- Прибирання завислих 'pending' (процес упав між записом і доставкою).
CREATE INDEX IF NOT EXISTS idx_digest_runs_pending ON digest_runs(created_at) WHERE status = 'pending';

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0006_digest');
