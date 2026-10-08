-- 08.10.2026. Нові дошки ATS крипто-роботодавців. Кожну перевірено наживо 08.10 (HTTP 200, щонайменше 1 вакансія);
-- рядки, яких реєстр ще не знав (решту зі списку власника реєстр уже читав). Harmony це lever:harmony
-- (ashby:harmony інша компанія). Слаг рядка = ats_slug, як у засіві.
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('keelinfrastructure', 'Keel Infrastructure', 'greenhouse', 'keelinfrastructure', 1, 'manual', 'verified 2026-10-08: 30 open jobs'),
  ('eclipsetrading', 'Eclipse Trading', 'greenhouse', 'eclipsetrading', 1, 'manual', 'verified 2026-10-08: 17 open jobs'),
  ('token2049', 'TOKEN2049', 'greenhouse', 'token2049', 1, 'manual', 'verified 2026-10-08: 16 open jobs'),
  ('funxyz', 'Fun.xyz', 'lever', 'funxyz', 1, 'manual', 'verified 2026-10-08: 16 open jobs'),
  ('trust-wallet', 'Trust Wallet', 'ashby', 'trust-wallet', 1, 'manual', 'verified 2026-10-08: 14 open jobs'),
  ('allium', 'Allium', 'ashby', 'allium', 1, 'manual', 'verified 2026-10-08: 12 open jobs'),
  ('harmony', 'Harmony', 'lever', 'harmony', 1, 'manual', 'verified 2026-10-08: 9 open jobs'),
  ('nibiru', 'Nibiru', 'lever', 'nibiru', 1, 'manual', 'verified 2026-10-08: 9 open jobs'),
  ('grvt', 'GRVT', 'ashby', 'grvt', 1, 'manual', 'verified 2026-10-08: 9 open jobs'),
  ('daos-hub', 'DAOs Hub', 'lever', 'daos-hub', 1, 'manual', 'verified 2026-10-08: 9 open jobs'),
  ('burnt', 'XION', 'greenhouse', 'burnt', 1, 'manual', 'verified 2026-10-08: 8 open jobs'),
  ('coinmarketcap', 'CoinMarketCap', 'lever', 'coinmarketcap', 1, 'manual', 'verified 2026-10-08: 7 open jobs'),
  ('novel', 'Novel', 'ashby', 'novel', 1, 'manual', 'verified 2026-10-08: 5 open jobs'),
  ('telcoin', 'Telcoin', 'greenhouse', 'telcoin', 1, 'manual', 'verified 2026-10-08: 4 open jobs'),
  ('cipherminingtechnologiesinc', 'Cipher Mining', 'greenhouse', 'cipherminingtechnologiesinc', 1, 'manual', 'verified 2026-10-08: 4 open jobs'),
  ('improbable', 'Improbable', 'ashby', 'improbable', 1, 'manual', 'verified 2026-10-08: 4 open jobs'),
  ('somnia', 'Somnia', 'ashby', 'somnia', 1, 'manual', 'verified 2026-10-08: 3 open jobs'),
  ('iftother', 'IFT', 'greenhouse', 'iftother', 1, 'manual', 'verified 2026-10-08: 3 open jobs'),
  ('trilitech', 'Trilitech', 'ashby', 'trilitech', 1, 'manual', 'verified 2026-10-08: 3 open jobs'),
  ('overmind', 'Overmind', 'lever', 'overmind', 1, 'manual', 'verified 2026-10-08: 3 open jobs'),
  ('swissblock', 'Swissblock', 'lever', 'swissblock', 1, 'manual', 'verified 2026-10-08: 2 open jobs'),
  ('airtm', 'Airtm', 'lever', 'airtm', 1, 'manual', 'verified 2026-10-08: 2 open jobs'),
  ('zetachain', 'ZetaChain', 'greenhouse', 'zetachain', 1, 'manual', 'verified 2026-10-08: 1 open jobs'),
  ('validationcloud', 'Validation Cloud', 'greenhouse', 'validationcloud', 1, 'manual', 'verified 2026-10-08: 1 open jobs')
ON CONFLICT DO NOTHING;
