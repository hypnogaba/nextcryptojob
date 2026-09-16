# Профіль-доказ: план реалізації

> Виконується в одній сесії (executing-plans), кроки з `- [ ]`. Спека:
> `docs/specs/2026-09-16-proof-profile-design.md`.

**Мета:** під карткою `/c/<код>` блок Proof; повний вигляд за ключем `?k=` і в PDF; керування в `/profile`.

**Архітектура:** чиста функція `profileView` будує один об'єкт з фактів, налаштувань і анкети; сторінка
й PDF беруть його. Налаштування в новій таблиці `profile_prefs`. Ключ виводиться HMAC з
`SESSION_SECRET` (окрема мітка `profile-key`), тож новий секрет не потрібен.

**Стек:** Next 16 на Cloudflare (OpenNext), D1, vitest з `@/test/sqlite-d1`, `pdf-lib` + `@pdf-lib/fontkit`,
шрифти з `lib/card/fonts` (TTF-підмножини, вже в бандлі).

**Замір (крок 0, зроблено):** Worker зараз 4,0 МБ gzip з 10 МБ; PDF лишається в тому самому Worker.

## Файли
| Файл | Роль |
|---|---|
| `db/migrations/0026_profile_prefs.sql` | таблиця налаштувань |
| `web/src/lib/card/profile-prefs.ts` (+test) | читання/запис налаштувань, ключ (вивід, хеш, пошук, reset), перевірка посилань |
| `web/src/lib/card/profile.ts` (+test) | `profileView(input, full)`: рядки Proof, слова, контакт, посилання; анонімний вигляд без особистих полів |
| `web/src/lib/card/profile-load.ts` | одне пакетне читання D1 для картки: user, identities, facts, prefs |
| `web/src/app/c/[slug]/card-data.ts`, `page.tsx` | вибір вигляду за ключем, блок Proof, метадані `noindex`/`no-referrer` |
| `web/src/app/c/[slug]/proof.tsx` | розмітка блоку Proof (серверний компонент) |
| `web/next.config.ts` | заголовки `Referrer-Policy`, `Cache-Control` для `/c/:slug` з `?k` |
| `web/src/app/profile/proof-panel.tsx`, `proof-actions.ts` (+test) | керування: копіювати посилання, hide, links, гаманець, reset |
| `web/src/app/c/[slug]/profile.pdf/route.ts`, `web/src/lib/card/pdf.ts` (+test) | PDF |
| `docs/legal/privacy-policy.md`, `how-scoring-works.md`, `docs/DECISIONS.md` | тексти й рішення |

## Задачі
- [ ] **1. Таблиця й налаштування.** Міграція за спекою, `key_version` замість збереженого ключа.
  `loadPrefs`, `setHidden(userId, itemId, hidden)`, `setLinks`, `setShowWallet`, `ensureKey` (версія 0→1),
  `resetKey` (+1), `profileKey(secret, userId, version)`, `findUserByKey(db, slug, key)` (за хешем і
  власником картки). Тести: вивід стабільний, reset робить старий ключ недійсним, чужий ключ до іншої
  картки не підходить, посилання лише https, до 5, назва до 40.
- [ ] **2. `profileView`.** Id пунктів: `<джерело>.<поле>` і `words.role`, `words.target`. Факти з
  `contracts.md` §3, `null` пропускаємо, гаманці через `deriveChains`/`onchainYears` з `lib/crm/project.ts`.
  Тести: анонімний JSON не містить тестових ніків, адрес, пошти, слів; схований пункт зникає в обох
  виглядах; `null` не дає рядка.
- [ ] **3. Сторінка.** `?k=` → `findUserByKey`; блок Proof під карткою; метадані `robots noindex`,
  `referrer: no-referrer`; заголовки в `next.config.ts` для запиту з `k`. Тест сторінки: без ключа
  немає посилань, з ключем є.
- [ ] **4. Керування в `/profile`.** Панель під картками для власника активної картки; server actions з
  `requireUser`, `audit` без ключа й адрес. Тести дій.
- [ ] **5. PDF.** `renderProfilePdf(view)` → `Uint8Array`; шрифт з підтримкою символу або заміна;
  клікабельні посилання; QR. Маршрут: ключ або сесія власника, інакше 404; заголовки за спекою.
  Тести: 404 без доступу, `%PDF` з доступом.
- [ ] **6. Тексти, перевірка, деплой.** Юридичні тексти й `DECISIONS.md`; `npm test`, `typecheck`, `lint`,
  `next build`; міграція на прод D1; деплой зі свіжого `main` лише після зелених тестів; живий прогін
  сторінки з ключем і без, PDF.
