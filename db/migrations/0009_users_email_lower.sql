-- Пошук людини за поштою без урахування регістру (web: lower(email) = ?).
CREATE INDEX IF NOT EXISTS idx_users_email_lower ON users(lower(email));
INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0009_users_email_lower');
