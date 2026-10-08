-- 08.10.2026. Дві дошки в реєстрі дублювали живі й лише засмічували Problems у /admin/sources.
-- kraken: Ashby-слаг `kraken` дає 404, Kraken тепер на `kraken.com` (той самий реєстр, рядок
--   'kraken.com', 87 вакансій 08.10). Старий рядок вимкнено, не перейменовано: слаг kraken.com уже зайнятий.
-- coin-metrics: Talos купив Coin Metrics, coinmetrics.io/careers веде на talos.com/working/open-roles,
--   а Talos уже читається як ashby:talos-trading.
-- Вакансії старих джерел не чіпаємо: їх прибере щотижнева чистка за віком.
UPDATE companies SET enabled = 0, note = 'moved 2026-10-08: Ashby slug is now kraken.com (row kraken.com)'
 WHERE slug = 'kraken';
UPDATE companies SET enabled = 0, note = 'moved 2026-10-08: acquired by Talos, jobs come from ashby:talos-trading'
 WHERE slug = 'coin-metrics';

DELETE FROM source_state WHERE source IN ('ashby:kraken', 'rippling:coin-metrics');
