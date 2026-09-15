-- NextCryptoJob, раунд 3 власника (14.09): той самий нік X, GitHub, YouTube, сайт чи гаманець може
-- бути в кількох профілях. Раніше UNIQUE(kind, value) віддавав нік першому, хто його вписав, і
-- справжній власник мусив ставити код у біо («It again asks me to verify X. No verification.»).
-- Тепер унікальність лише в межах профілю: UNIQUE(user_id, kind, value). Злиття профілів
-- (web/src/lib/account/merge.ts) теж спирається на це: однакове джерело двох профілів не конфліктує.
--
-- SQLite не змінює обмеження на місці, тож таблицю перебудовуємо: нова, копія рядків з тими самими
-- id, стара геть, нова під старою назвою. На identities ніхто не посилається зовнішнім ключем, тож
-- DROP нічого не обнуляє. Унікальність окремим іменованим індексом, а не обмеженням таблиці: так
-- файл можна накотити вдруге без конфлікту назв автоіндексу.
-- Накочує controller, ДО деплою коду: код більше не ловить помилку UNIQUE на чужому ніку.

CREATE TABLE IF NOT EXISTS identities_next (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('x', 'github', 'youtube', 'site', 'evm', 'solana', 'sherlock')),
    value        TEXT NOT NULL,
    verified_via TEXT CHECK (verified_via IN ('bio_code', 'post_code', 'signature', 'oauth', 'profile_link')),
    verified_at  TEXT,
    verify_code  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT INTO identities_next (id, user_id, kind, value, verified_via, verified_at, verify_code, created_at)
SELECT id, user_id, kind, value, verified_via, verified_at, verify_code, created_at FROM identities;

DROP TABLE identities;
ALTER TABLE identities_next RENAME TO identities;

-- Той самий індекс веде й пошук джерел людини (user_id першим), окремий idx_identities_user зайвий.
CREATE UNIQUE INDEX IF NOT EXISTS uq_identities_user_kind_value ON identities(user_id, kind, value);

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0022_identities_shared');
