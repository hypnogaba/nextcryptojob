-- NextCryptoJob, база вакансій: токен роботодавця і його ринкові дані з CoinGecko (14.09.2026).
--
-- Картка вакансії на /jobs, лист, Telegram і search_jobs показують поруч із посиланням на сайт компанії
-- короткий рядок «$ARB $0.42 · MC $1.9B · +3.1%», якщо в компанії є свій токен. Пише лише engine:
--   jobs-tokens (щотижня після jobs-discover і jobs-about): зіставлення компанії з монетою CoinGecko.
--     Монета годиться, лише коли її links.homepage веде на домен компанії (companies.domain) або коли
--     пару задано руками (engine/src/jobs/token-overrides.ts). Без домену нічого не вгадується.
--   ціни (щодня після jobs-scan): один пакетний запит /simple/price на всі зіставлені монети.
--     Збій лишає попередні значення; сайт ховає рядок, коли token_updated_at старший за 3 доби.
--
--   coingecko_id      'arbitrum'; NULL = токена немає або ще не знайдено
--   token_symbol      'ARB'
--   token_confidence  'override' (задано руками, зокрема «токена немає») | 'homepage' (домен сайту монети
--                     збігся з доменом компанії) | 'none' (перевірено, не знайдено; повтор через 28 днів)
--   token_checked_at  коли зіставлення перевірено востаннє (ISO)
--   token_price_usd, token_mcap_usd, token_change_24h (%), token_updated_at (ISO, час ціни в CoinGecko)
--
-- Номер 0004: вільний на 14.09.2026 (0005 зайняла доріжка профілю компанії); міграції накочуються за назвою.
-- Без індексів: рядків кілька сотень; ціни пишуться раз на добу лише зіставленим (десятки рядків).
-- Накочувати ДО нового engine і сайту. Без цих стовпців сайт, добірка й engine працюють як раніше (без рядка
-- токена): читання падає на «no such column» і повторюється без них.
ALTER TABLE companies ADD COLUMN coingecko_id TEXT;
ALTER TABLE companies ADD COLUMN token_symbol TEXT;
ALTER TABLE companies ADD COLUMN token_confidence TEXT CHECK (token_confidence IN ('override', 'homepage', 'none'));
ALTER TABLE companies ADD COLUMN token_checked_at TEXT;
ALTER TABLE companies ADD COLUMN token_price_usd REAL;
ALTER TABLE companies ADD COLUMN token_mcap_usd REAL;
ALTER TABLE companies ADD COLUMN token_change_24h REAL;
ALTER TABLE companies ADD COLUMN token_updated_at TEXT;

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0004_company_token');
