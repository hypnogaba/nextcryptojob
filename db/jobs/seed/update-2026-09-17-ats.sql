-- Доповнення живої бази nextcryptojob-jobs (17.09.2026): роботодавці на ATS, які скан читає з 0006.
-- registry.json (засів 14.09) не змінюється: реєстр далі живе в базі, як і рядки розвідки. Накочує controller ПІСЛЯ db/jobs/0006_more_ats.sql:
-- wrangler d1 execute nextcryptojob-jobs --remote --file db/jobs/seed/update-2026-09-17-ats.sql
INSERT OR IGNORE INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('kast', 'KAST', 'pinpoint', 'kastcard', 1, 'curated', 'careers.kast.xyz is backed by Pinpoint (kastcard.pinpointhq.com, 17 open on 2026-09-17); found while resolving Getro ''careers page without an ATS link'' companies');
