-- NextCryptoJob, доріжка web: картки балу (docs/contracts.md, розділ 7).
-- Картка = знімок балу ролі для поширення в X: /c/<slug>. Єдина публічна сторінка,
-- тому тут лише бал, роль, рівень і ім'я для показу, без гаманців і посилань.
-- Спирається на users з 0001_core. Накочує controller, не доріжка.

CREATE TABLE IF NOT EXISTS cards (
    slug            TEXT PRIMARY KEY,                    -- 10 символів [A-Za-z0-9_-]
    user_id         TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,                       -- ключ ролі (docs/contracts.md, розділ 1)
    score           REAL NOT NULL CHECK (score >= 0 AND score <= 100),
    level           INTEGER NOT NULL CHECK (level BETWEEN 1 AND 10), -- min(10, floor(score/10) + 1)
    display_name    TEXT NOT NULL,
    formula_version TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    revoked_at      TEXT                                 -- не NULL = відкликана, сторінка віддає 404
);
CREATE INDEX IF NOT EXISTS idx_cards_user_role ON cards(user_id, role);
-- Активна картка одна на людину й роль: createCard відкликає стару в тій самій транзакції.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_active ON cards(user_id, role) WHERE revoked_at IS NULL;

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0005_cards');
