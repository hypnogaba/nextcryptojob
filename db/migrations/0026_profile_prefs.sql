-- Профіль-доказ (docs/specs/2026-09-16-proof-profile-design.md).
--
-- Налаштування сторінки /c/<код> для власника: що сховати, свої посилання, чи показувати адреси
-- гаманців, версія особистого ключа для подачі (?k=). Сам ключ ніде не зберігається: він виводиться
-- HMAC із SESSION_SECRET, user_id і версії (lib/card/profile-prefs.ts) і перевіряється так само.
-- key_version = 0: ключа ще немає; «Reset apply link» додає 1, і старе посилання перестає діяти.
-- Немає рядка = типові значення.
CREATE TABLE IF NOT EXISTS profile_prefs (
    user_id      TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    key_version  INTEGER NOT NULL DEFAULT 0,
    hidden_json  TEXT NOT NULL DEFAULT '[]',   -- id схованих пунктів: ["github.stars", "words.role"]
    links_json   TEXT NOT NULL DEFAULT '[]',   -- [{"label":"…","url":"https://…"}], до 5
    show_wallet  INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
) WITHOUT ROWID;

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0026_profile_prefs');
