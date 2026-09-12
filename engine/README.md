# engine

Сервіс NextCryptoJob на VPS. Бере завдання з черги `score_jobs` у D1, збирає публічні
факти про кандидата (X, GitHub, гаманці EVM і Solana, Hyperliquid, YouTube, сайт),
пише їх у `source_facts` і рахує бал 0–100 за ролями (формула v5) у `scores`.
Договір із web (типи, формула, черга, змінні оточення): `../docs/contracts.md`.

Зараз тут лише основа. `src/http.ts` (безпечний fetch) і `src/d1.ts` (D1 через REST API)
перенесено з NextRole, написано до запуску 14.09.2026. `src/limits.ts` дає бюджет
запитів на провайдера (єдиний дросель для http і d1), `src/types.ts` типи фактів.
`src/formula/` формула v5 чистими функціями: `scorePerson(facts)` дає бали джерел і ролей
з `breakdown_json`. `npm run parity` звіряє її з Python-еталоном `research/harness/score_v5.py`,
якщо поруч є дані дослідження (`research/data/`, у git їх немає: це реальні люди).

```sh
npm install       # потрібен Node 24
npm test          # vitest run
npm run typecheck # tsc разом із тестами
npm run build     # tsc -> dist/
npm run parity    # звірка з Python v5 (потрібні python3 і research/data)
```

Облікові дані (`CF_ACCOUNT_ID`, `CF_D1_DATABASE_ID`, `CF_API_TOKEN` та ключі джерел) живуть
у `/etc/nextcryptojob-engine.env` на VPS і ніколи не потрапляють у git. Тестам вони не потрібні.
