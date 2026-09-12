-- Пошук останньої задачі людини (web: статус профілю, правило 60 с; engine: одна задача на людину).
CREATE INDEX IF NOT EXISTS idx_score_jobs_user ON score_jobs(user_id, id);
INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0010_score_jobs_user');
