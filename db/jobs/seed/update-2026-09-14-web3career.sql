-- Доповнення реєстру живої бази nextcryptojob-jobs (registry_2026_09_14_web3career). ЗГЕНЕРОВАНО з db/jobs/seed/registry.json:
--   cd engine && npx tsx scripts/jobs-seed.ts update
-- web3.career через офіційний API: 5 роботодавців з їхніми дошками Greenhouse і нові умови дошки web3.career
-- Накочує controller: wrangler d1 execute nextcryptojob-jobs --remote --file db/jobs/seed/<цей файл>
UPDATE sources SET feed_url = 'https://web3.career/api/v1', terms_note = 'official Web3 Jobs API with our token (WEB3CAREER_TOKEN, since 2026-09-14), read by src/jobs/sources/web3career.ts whatever the kind; terms: link to apply_url unchanged with a follow link (no nofollow, no added params), name web3.career as the source, token private' WHERE name = 'board:web3career';
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('bcb-group', 'BCB Group', 'greenhouse', 'bcbgroup', 1, 'curated', 'board name ''BCB Group'' on the EU Greenhouse host (1 open on 2026-09-14; bcbgroup.com/careers lists the same role); crypto payments'),
  ('blue-cube-services', 'Blue Cube Services', 'greenhouse', 'bluecubeservices', 1, 'curated', 'board name ''Blue Cube Services'', customer and user operations for crypto partners (8 open on 2026-09-14); listed by web3.career'),
  ('dv-trading', 'DV Trading', 'greenhouse', 'dvtrading', 1, 'curated', 'board name ''DV Trading'' (67 open, 18 posted within 30 days on 2026-09-14); proprietary trading firm with the crypto desk DV Chain, all roles also listed by web3.career'),
  ('localcoin', 'Localcoin', 'greenhouse', 'localcoin', 1, 'curated', 'localcoinatm.com/careers links boards.greenhouse.io/localcoin (5 open on 2026-09-14); Bitcoin ATM operator'),
  ('tastylive', 'tastylive', 'greenhouse', 'tastylive', 1, 'curated', 'tastylive.com/careers links boards.greenhouse.io/tastylive (15 open on 2026-09-14); listed by web3.career')
  ON CONFLICT DO NOTHING;
INSERT OR IGNORE INTO schema_migrations(name) VALUES ('registry_2026_09_14_web3career');
