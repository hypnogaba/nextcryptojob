-- 08.10.2026. ChainJobs: відкритий JSON (CC BY 4.0). Читається за назвою джерела (engine/src/jobs/sources/chainjobs.ts),
-- kind 'jsonld' лише тому, що CHECK на sources.kind інших не знає (як board:web3career). Накочувати ПІСЛЯ деплою
-- engine з chainjobs.ts: старий скан прочитав би цю адресу як сторінку дошки.
INSERT INTO sources (name, label, kind, feed_url, site_url, crypto_only, enabled, terms_note) VALUES
  ('aggregator:chainjobs', 'ChainJobs', 'jsonld', 'https://chainjobs.io/api/jobs.json', 'https://chainjobs.io', 1, 1,
   'open JSON, CC BY 4.0: name and link chainjobs.io on every job ("via chainjobs.io"), keep the employer apply_url; jobs we read straight from the employer ATS win')
ON CONFLICT(name) DO NOTHING;

-- Block і Robinhood не крипто-компанії, але мають крипто-команди: скан бере лише вакансії з крипто-словом у назві
-- (engine/src/jobs/sources/ats.ts CRYPTO_TITLE_ONLY). Накочувати теж ПІСЛЯ деплою engine з цим фільтром.
INSERT INTO companies (slug, name, ats_provider, ats_slug, enabled, discovered_via, note) VALUES
  ('block', 'Block', 'greenhouse', 'block', 1, 'manual', 'crypto titles only (CRYPTO_TITLE_ONLY): Bitkey, Proto, bitcoin'),
  ('robinhood', 'Robinhood', 'greenhouse', 'robinhood', 1, 'manual', 'crypto titles only (CRYPTO_TITLE_ONLY): Robinhood Crypto')
ON CONFLICT DO NOTHING;
