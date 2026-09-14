# Щоденна добірка вакансій (engine, задача E7)

`node dist/cli.js digest-due` раз на годину (о :05, `deploy/nextcryptojob-digest.timer`).

## Кому і коли

- `users.roles` не порожній, у `scores` є хоч один рядок людини, `users.digest_paused = 0`
  (0011; `/stop` у боті ставить 1, `/start` знімає; канал при цьому не міняється). Поки 0011 не
  накочено, пауза не діє, у журналі рядок `digest_paused missing`.
- Година в поясі людини (`users.timezone`, порожній або невідомий = UTC) дорівнює `digest_hour`
  або наступна за нею (без переходу через північ). Запас на пропущений запуск таймера і на
  весняний перевід годинника, коли 02:00 не настає. Рахує `Intl`, тож DST на боці бази поясів.
- Один раз на дату людини: `digest_runs UNIQUE(user_id, local_date)`.

## Звідки вакансії

1. База вакансій NextCryptoJob, D1 `nextcryptojob-jobs` (`db/jobs`, змінна `CF_JOBS_D1_DATABASE_ID`),
   **лише читання**: пише її сканер (`src/jobs`, `jobs-scan` щодня о 04:30 UTC), а `jobs-db.ts` віддає
   назовні тільки `select` і відкидає все, крім однієї інструкції SELECT/WITH. Один запит на прогін і лише
   коли комусь пора: вакансії, які скан бачив за 3 доби (`fetched_at`), з тегом `web3`, опубліковані за
   30 днів. Індексу на `fetched_at` немає навмисно (скан щодня переписує це поле, індекс подвоював би
   записи), тож це повний прохід, але база лише крипто: скан насухо 14.09 дав 1 599 рядків.
   До 14.09.2026 добірка читала базу NextRole (`crypto-jobs-agent`); тепер NextCryptoJob від неї не залежить.
2. Наша `company_jobs_live` (0004/0012): не більше однієї вакансії компанії в добірці, лише з роллю
   людини, першою в списку, з підписом "Posted by {Company} on NextCryptoJob". Після доставки
   `company_jobs.digest_shown + 1`.

Чистка (список складено 12.09 на кеші NextRole, де з 2 476 живих рядків з тегом web3 лишилось 1 799):
список не-крипто компаній (`clean.ts`; сканер відкидає їх ще при записі), назви не про нашу аудиторію
(`roles.ts NON_CRYPTO_TITLE`: розшифровувачі аудіо, кухарі, техніки центрів обробки даних, «General
Application») і назва мусить мапитись на нашу роль (`titleRoles`, словник спільний з
`web/src/lib/roles/suggest.ts`). Скан насухо 14.09: з 1 599 рядків у пул іде 1 440.

## Підбір (`match.ts`)

До 5 вакансій: роль обов'язкова; місце (`remote` віддалені, `city` місто в локації без регістру й
діакритики, `remote,city` обидва, місто спершу); зарплата м'яко (дотягує до мінімуму > невідомо >
нижче; USD/EUR/GBP грубо в долари, решта валют = невідомо); свіжіші спершу; одна на компанію; нічого з
`sent` цієї людини, і та сама вакансія під новою адресою (`dedupe_key`) теж. Кілька ролей людини
набираються по колу, щоб друга роль не зникала за першою. Рядок «чому» англійською, без довгого тире:
`Matches your Security auditor role. Remote. Salary listed: $120k to $150k.`

## Запис і доставка

Одним пакетом (одна транзакція D1): `digest_runs` `pending` + до 5 рядків `sent` `pending`
(`job_ref` = `nr:<jobs_cache.id>` або `co:<company_jobs.id>`; `nr:` і `sent.source = 'nextrole'` це
збережені мітки вакансії зі сканування, з часів NextRole). Далі доставка й статуси `sent`/`failed`.
Друга копія прогону впирається в UNIQUE і нічого не шле. `pending`, старший за 30 хвилин
(процес упав між записом і доставкою), наступний прогін робить `failed` з `interrupted before delivery`.
Нічого не підійшло: `digest_runs.status = 'empty'`.

Канал: `users.channel`; якщо ним нема чим слати, другий, що є в людини.
- Telegram: Bot API `sendMessage`, HTML, одне повідомлення на 5 вакансій, `TELEGRAM_BOT_TOKEN`.
  Без токена людину пропускаємо (у базу нічого, вакансії не згорають), у журналі причина.
  429: чекаємо `retry_after` (до 60 с), до 3 спроб. 403 (бота заблоковано) або 400 `chat not found`:
  Telegram `failed`, і якщо є пошта, лист (у `digest_runs.error` примітка `sent by email instead`).
- Пошта: запит на сайт (нижче). Немає `SITE_URL` або `INTERNAL_API_SECRET`, або сайт відповів 503:
  `failed` з причиною `email not configured`.

## Контракт ендпойнта листа (реалізує web, задача W7)

`POST ${SITE_URL}/api/internal/digest-email`

Заголовки:
- `Content-Type: application/json`
- `NCJ-Internal-Signature: sha256=<hex>`, де `<hex>` = HMAC-SHA256(ключ `INTERNAL_API_SECRET`,
  **сирі байти тіла** запиту), нижній регістр.

Тіло (UTF-8 JSON):

```json
{
  "version": 1,
  "digest_id": "dg_5f0c…",
  "user_id": "<users.id>",
  "local_date": "2026-09-12",
  "ts": 1789196700,
  "jobs": [
    {
      "position": 1,
      "title": "Protocol Engineer",
      "company": "Paying Labs",
      "location": "Remote",
      "salary": "$120k to $150k",
      "why": "Matches your Engineer role. Remote. Salary listed: $120k to $150k.",
      "url": "https://paying.example/apply",
      "posted_by": "Paying Labs",
      "source": "company"
    }
  ]
}
```

`location`, `salary`, `posted_by` можуть бути `null`. `posted_by` не `null` лише для вакансій компаній
(показати "Posted by {Company} on NextCryptoJob"). `url` вакансії компанії: її сторінка на сайті
`${SITE_URL}/jobs/<id>` (без `SITE_URL` домен), звідки "Apply" веде на `apply_url` компанії й рахує перехід.
`ts` ставиться під час кожної спроби відправки, а не на початку прогону. Адреси пошти в тілі немає: сайт бере `users.email`
за `user_id` (інваріант §10: пошта лише перевірена) і сам вирішує про згоду й посилання «Unsubscribe».

Що сайт мусить робити:
1. Порахувати HMAC над сирим тілом до розбору JSON і порівняти за сталий час; не збігся → 401.
2. Відкинути `|now - ts| > 300` с → 401 (захист від повтору).
3. Ідемпотентність за `digest_id`: повторний запит з тим самим `digest_id` не шле другий лист,
   відповідає 200 або 409. Engine повторює запит один раз після мережевого збою чи 5xx.
4. Пошта ще не налаштована (немає ключа поштового сервісу) → 503. Engine запише `email not configured`.

Відповіді, які розуміє engine: 2xx і 409 = доставлено; 503 = `email not configured`; інші 4xx =
`failed` без повтору (`email endpoint HTTP <код>`); 5xx і мережа = один повтор через 2 с, потім `failed`.
409 сайт дає лише тоді, коли лист цього `digest_id` справді пішов; поки інший запит ще шле, відповідь 425
(engine пише `failed`, другого листа немає). Повні коди сайту: `web/src/lib/digest/email.ts`.

## Змінні оточення

| Змінна | Потрібна | Що робить |
|---|---|---|
| `CF_ACCOUNT_ID`, `CF_API_TOKEN` | так | ті самі, що для нашої бази; токен має читати й `nextcryptojob-jobs` |
| `CF_D1_DATABASE_ID` | так | наша база (`users`, `scores`, `sent`, `digest_runs`, `company_jobs_live`) |
| `TELEGRAM_BOT_TOKEN` | для Telegram | той самий бот, що в сайту; без нього Telegram-люди пропускаються |
| `SITE_URL` | для листів і посилань | напр. `https://nextcryptojob.xyz`; лише https |
| `INTERNAL_API_SECRET` | для листів | спільний із сайтом секрет підпису |
| `CF_JOBS_D1_DATABASE_ID` | так | база вакансій `nextcryptojob-jobs` (`deploy/README.md` §8); id бази NextRole відкидається |

## Ручні команди

```sh
node dist/cli.js digest-due --dry-run                     # кому пора зараз і що б пішло; нічого не пише
node dist/cli.js digest-due --dry-run --user <user-id>    # одна людина, незалежно від години
node dist/cli.js digest-due --dry-run --profile '{"roles":["engineer"],"remote_mode":"remote,city","city":"Paris"}'
```
