# Експлуатація сайту (web): що не можна робити й як перевіряти

Короткі правила для того, хто розгортає Worker `nextcryptojob` (web/). Рушій має свій `engine/deploy/README.md`.

## WEBHOOK_SIGNING_KEY: не змінювати після запуску
- Секрет вебхука кожної компанії не зберігається, а виводиться: `whsec_` + base64url(HMAC-SHA256(`WEBHOOK_SIGNING_KEY`,
  "{company_id}:{версія}")) (специфікація CRM 7.6, `web/src/lib/crm/webhooks.ts`).
- Нове значення ключа мовчки міняє секрети ВСІХ компаній: їхні приймачі почнуть відкидати кожну подію, cron
  шість разів повторить і позначить вебхуки failing.
- Ключ ставиться один раз (`wrangler secret put WEBHOOK_SIGNING_KEY`, 32+ випадкових байтів) і далі не змінюється.
- Якщо ключ таки скомпрометовано: це окрема процедура з попередженням компаніям заздалегідь (кожна після зміни
  натискає "Rotate secret" і оновлює свій приймач). Ротація секрету однієї компанії ключа не змінює.
- Без ключа вебхуки вимкнені чесно: `set_webhook` відповідає 503 "not configured: WEBHOOK_SIGNING_KEY",
  доставка чекає, спроб не витрачає.

## Cron
- Тригери: `triggers.crons` у `web/wrangler.jsonc` = `CRONS` у `web/src/lib/cron/index.ts` (тест звіряє).
  Після деплою їх видно в `wrangler deployments` і на вкладці Triggers у панелі Cloudflare.
- Обробник `scheduled` у `web/worker.ts` чекає весь запуск (await). Не переносити роботу в `ctx.waitUntil`:
  там її обривають приблизно за 30 с після виходу з обробника, а запуск звітує ok.
- Кожна задача пише рядок JSON з лічильниками в журнал Worker (observability увімкнено).
- Локальна перевірка (лише локальна D1, без `--remote`):
  ```
  cd web && npm run cf:build
  for f in ../db/migrations/*.sql; do npx wrangler d1 execute nextcryptojob --local --file "$f"; done
  npx wrangler dev --test-scheduled
  curl "http://localhost:8787/__scheduled?cron=*/5+*+*+*+*"
  curl "http://localhost:8787/__scheduled?cron=0+*+*+*+*"
  curl "http://localhost:8787/__scheduled?cron=0+3+*+*+*"
  ```
  Секрети для цього в `web/.dev.vars` (не комітиться): `SESSION_SECRET`, `WEBHOOK_SIGNING_KEY` з тестовими значеннями.
