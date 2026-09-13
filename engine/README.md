# engine

Сервіс NextCryptoJob на VPS. Бере завдання з черги `score_jobs` у D1, збирає публічні
факти про кандидата (X, GitHub, гаманці EVM і Solana, Hyperliquid, YouTube, сайт),
пише їх у `source_facts` і рахує бал 0–100 за ролями (формула v6) у `scores`.
Договір із web (типи, формула, черга, змінні оточення): `../docs/contracts.md`.

`src/http.ts` (безпечний fetch) і `src/d1.ts` (D1 через REST API)
перенесено з NextRole. `src/limits.ts` дає бюджет
запитів на провайдера (єдиний дросель для http і d1), `src/types.ts` типи фактів.
`src/formula/` формула v6 чистими функціями: `scorePerson(facts)` дає бали джерел і ролей
з `breakdown_json`. `npm run parity` звіряє її з Python-еталоном `research/harness/score_v6.py`
тієї самої копії репозиторію, якщо вище є дані дослідження (`research/data/`, у git їх немає: це
реальні люди; у worktree даних немає, скрипт шукає їх угору).

Збирачі живуть у `src/collectors/` (по файлу на джерело: x, github, site, youtube, audits, dune;
гаманці evm, hyperliquid, solana зі спільним бюджетом часу в `onchain.ts`).
Кожен повертає `Collected<Facts>` (`types.ts`: `Fetched` плюс `partial` з примітками адрес) і отримує
від конвеєра env, signal, межу збору людини й годинник; без ключа джерело дає прогалину
`not configured: <KEY>`. Мережа лише через `safeFetch`: з'єднання йде тільки на IP, перевірену
в момент підключення (захист від DNS rebinding). Жива перевірка одного збирача на справжніх ключах:
`npm run smoke -- <x|github|site|youtube|dune|audits> <значення>` (у тестах не запускається).

`src/pipeline/` конвеєр: `queue.ts` черга `score_jobs` (взяття з перевіркою changes = 1, до 3 спроб,
завислі, щотижневе оновлення рівномірно по годинах), `run-person.ts` `scoreUser` (збирачі паралельно
з дедлайном 45 с, формула, один пакет запису `source_facts` і `scores`), `quality-gate.ts` ворота
якості. Збирачі конвеєр бачить лише через `registry.ts` (`CollectorRegistry`); тести беруть
`fake-registry.ts` і справжній SQLite (`src/testing/sqlite-d1.ts`), продукт `realRegistry.ts`
(усі 9 збирачів; межа збору = старт + `ENGINE_DEADLINE_MS` іде кожному). Профіль Sherlock звіряється
лише з підтвердженими GitHub і X (`verified_at`).
`src/main.ts` worker, `src/cli.ts` команди (`worker`, `score-user`, `enqueue-refresh`,
`quality-gate`, `score-facts`, `digest-due`). Встановлення на VPS: `deploy/README.md`.

`src/digest/` щоденна добірка вакансій (`digest-due`, щогодинний таймер): кеш NextRole лише для
читання (`jobs-db.ts`), чистка не-крипто (`clean.ts`, `roles.ts`), підбір (`match.ts`), доставка
Telegram або листом через сайт (`deliver.ts`), розклад і запис `sent`/`digest_runs` (`schedule.ts`).
Контракт листа й правила підбору: `src/digest/README.md`.

Живий прогін без D1 (лише для людей, що погодились; X і GitHub тут вважаються підтвердженими):

```sh
npm run build
ETHERSCAN_KEY=… GITHUB_TOKEN=… TWITTER_TOKEN=… \
  node dist/cli.js score-facts --x <нік> --github <логін> --site <url> --evm <0x…,0x…> --solana <адреса> [--sherlock <нік>] [--json]
```

Друкує, які ключі є (без значень), час і результат кожного джерела, прогалини й бали ролей.

```sh
npm install       # потрібен Node 24
npm test          # vitest run
npm run typecheck # tsc разом із тестами
npm run build     # tsc -> dist/
npm run parity    # звірка з Python v6 (потрібні python3 і research/data)
```

Облікові дані (`CF_ACCOUNT_ID`, `CF_D1_DATABASE_ID`, `CF_API_TOKEN` та ключі джерел) живуть
у `/etc/nextcryptojob-engine.env` на VPS і ніколи не потрапляють у git. Тестам вони не потрібні.
