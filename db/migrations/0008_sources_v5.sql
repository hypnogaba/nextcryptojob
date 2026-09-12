-- v5: нова ідентичність 'sherlock' і джерела 'audits', 'dune'. Таблиці ще порожні, тому перебудова безпечна.
DROP TABLE IF EXISTS source_facts;
DROP TABLE IF EXISTS identities;

CREATE TABLE identities (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL CHECK (kind IN ('x', 'github', 'youtube', 'site', 'evm', 'solana', 'sherlock')),
    value        TEXT NOT NULL,
    verified_via TEXT CHECK (verified_via IN ('bio_code', 'post_code', 'signature', 'oauth', 'profile_link')),
    verified_at  TEXT,
    verify_code  TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (kind, value)
);
CREATE INDEX IF NOT EXISTS idx_identities_user ON identities(user_id);

CREATE TABLE source_facts (
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    source     TEXT NOT NULL CHECK (source IN ('x', 'github', 'evm', 'hyperliquid', 'solana', 'youtube', 'site', 'audits', 'dune')),
    facts_json TEXT,
    gap_reason TEXT,
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, source)
);

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0008_sources_v5');
