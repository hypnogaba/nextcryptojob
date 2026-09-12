# engine

Сервіс NextCryptoJob на VPS. Бере завдання з черги `score_jobs` у D1, збирає публічні
факти про кандидата (X, GitHub, гаманці EVM і Solana, Hyperliquid, YouTube, сайт),
пише їх у `source_facts` і рахує бал 0–100 за ролями (формула v4) у `scores`.
Договір із web (типи, формула, черга, змінні оточення): `../docs/contracts.md`.

Зараз тут лише основа: `src/http.ts` (безпечний fetch), `src/d1.ts` (D1 через REST API),
обидва перенесені з NextRole; `src/limits.ts` (обмежувачі запитів на хост); `src/types.ts`.
Потрібен Node 24.

```sh
npm install
npm test          # vitest run
npm run typecheck # tsc --noEmit
npm run build     # tsc -> dist/
```

Облікові дані (`CF_ACCOUNT_ID`, `CF_D1_DATABASE_ID`, `CF_API_TOKEN` та ключі джерел) живуть
у `/etc/nextcryptojob-engine.env` на VPS і ніколи не потрапляють у git. Тестам вони не потрібні.
