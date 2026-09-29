-- Воронка (аудит 29.09, розділ F): відгук на вакансію і службові повідомлення людям.
--
-- job_feedback: 👍/👎 під вакансією в добірці (Telegram: кнопки, лист: «Not for me»). Один голос на пару
-- (людина, вакансія), повторне натискання міняє голос. 👎 на 30 днів прибирає з добірки цієї людини
-- всі вакансії тієї самої компанії (engine/src/digest/schedule.ts): company_key = brandKey компанії,
-- як companyKey вакансії в підборі; NULL, коли компанію не вдалося визначити (тоді рушій бере її з пулу
-- за job_ref, поки вакансія в пулі). reason: необов'язкова причина зі сторінки листа («wrong_level»).
CREATE TABLE IF NOT EXISTS job_feedback (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    job_ref     TEXT NOT NULL,                              -- sent.job_ref: 'nr:<id>' або 'co:<id>'
    vote        TEXT NOT NULL CHECK (vote IN ('up', 'down')),
    reason      TEXT,
    company_key TEXT,
    at          TEXT NOT NULL DEFAULT (datetime('now')),    -- UTC, останній голос
    UNIQUE (user_id, job_ref)
);
-- Виключення компаній людини за 30 днів і лічильник в адмінці.
CREATE INDEX IF NOT EXISTS idx_job_feedback_user_at ON job_feedback(user_id, at);
CREATE INDEX IF NOT EXISTS idx_job_feedback_at ON job_feedback(at);

-- nudges: одне повідомлення воронки людині (журнал і замок «не більше разу»).
--   onboarding_reminder  нагадування через 24 год тому, хто зупинився на першому кроці (раз за життя)
--   still_looking        «Ще шукаєш?» після 14 днів тиші; answered_at ставить кнопка «Yes»
--   inactive_pause       digest_paused = 1 після 3 днів без відповіді на still_looking
--   empty_week           «цього тижня нічого не підійшло» (не частіше раз на тиждень)
--   tg_blocked_notice    у листі сказано, що бот заблоковано й добірка йде поштою (раз, поки бот знову не досяжний)
-- Розмір вікон (30 днів, 7 днів) рахує код: рядки лишаються журналом для адмінки.
CREATE TABLE IF NOT EXISTS nudges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind        TEXT NOT NULL CHECK (kind IN ('onboarding_reminder', 'still_looking', 'inactive_pause', 'empty_week', 'tg_blocked_notice')),
    channel     TEXT CHECK (channel IN ('telegram', 'email')),
    sent_at     TEXT NOT NULL DEFAULT (datetime('now')),
    answered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_nudges_user_kind ON nudges(user_id, kind, sent_at);
CREATE INDEX IF NOT EXISTS idx_nudges_sent_at ON nudges(sent_at);
-- Ці два не можна надіслати вдруге: замок на рівні бази, а не лише в коді.
CREATE UNIQUE INDEX IF NOT EXISTS idx_nudges_once ON nudges(user_id, kind)
    WHERE kind IN ('onboarding_reminder', 'tg_blocked_notice');

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0028_funnel');
