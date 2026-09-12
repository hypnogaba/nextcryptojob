# engine

Сервіс NextCryptoJob на VPS. Бере завдання з черги `score_jobs` у D1, збирає публічні
факти про кандидата (X, GitHub, гаманці EVM і Solana, Hyperliquid, YouTube, сайт),
пише їх у `source_facts` і рахує бал 0–100 за ролями (формула v4) у `scores`.
Договір із web (типи, формула, черга, змінні оточення): `../docs/contracts.md`.

Зараз тут лише основа. `src/http.ts` (безпечний fetch) і `src/d1.ts` (D1 через REST API)
перенесено з NextRole, написано до запуску 14.09.2026. `src/limits.ts` дає бюджет
запитів на провайдера (єдиний дросель для http і d1), `src/types.ts` типи фактів.

Збирачі живуть у `src/collectors/` (по файлу на джерело: x, github, site, youtube, audits, dune).
Кожен повертає `Fetched<Facts>` і приймає `{ env, signal }`; без ключа джерело дає прогалину
`not configured: <KEY>`. Мережа лише через `safeFetch`: з'єднання йде тільки на IP, перевірену
в момент підключення (захист від DNS rebinding). Жива перевірка одного збирача на справжніх ключах:
`npm run smoke -- <x|github|site|youtube|dune|audits> <значення>` (у тестах не запускається).

```sh
npm install       # потрібен Node 24
npm test          # vitest run
npm run typecheck # tsc разом із тестами
npm run build     # tsc -> dist/
```

Облікові дані (`CF_ACCOUNT_ID`, `CF_D1_DATABASE_ID`, `CF_API_TOKEN` та ключі джерел) живуть
у `/etc/nextcryptojob-engine.env` на VPS і ніколи не потрапляють у git. Тестам вони не потрібні.
