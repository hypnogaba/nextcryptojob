-- 17.09.2026. Власник JobStash написав через /contact, що не хоче, щоб ми читали його дошку.
-- Рішення власника NextCryptoJob того ж дня: джерело закрито назавжди, його вакансії з бази прибрано.
-- Сканер додатково блокує сам хост (engine/src/jobs/sources/boards.ts, BLOCKED_BOARDS), тож рядок у
-- sources не повернути помилковим UPDATE: запиту до jobstash.xyz не буде в жодному разі.
UPDATE sources
   SET enabled = 0,
       terms_note = 'closed 2026-09-17 at the board owner''s request; scanner also blocks the host (BLOCKED_BOARDS)'
 WHERE name = 'board:jobstash';

DELETE FROM jobs_cache  WHERE source = 'board:jobstash';
DELETE FROM source_state WHERE source = 'board:jobstash';
