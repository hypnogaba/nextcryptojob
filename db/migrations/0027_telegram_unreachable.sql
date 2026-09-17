-- Telegram недосяжний (власник 17.09: «позначати й слати поштою»).
--
-- Добірка ставить позначку, коли Telegram відповідає, що людини через бота не досягти (403 бот
-- заблоковано, 400 chat not found): людина не натискала Start або Telegram від іншого бота.
-- Далі така людина з поштою отримує добірку листом одразу, без спроби в Telegram; без пошти
-- добірка її не бере, і щоденний прогін не падає через неї. Будь-яке повідомлення людини боту
-- знімає позначку (web/src/lib/telegram/webhook.ts). NULL = досяжна або ще не перевірено.
ALTER TABLE users ADD COLUMN telegram_unreachable_at TEXT;

INSERT OR IGNORE INTO schema_migrations(name) VALUES ('0027_telegram_unreachable');
