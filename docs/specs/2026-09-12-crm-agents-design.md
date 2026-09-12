# NextCryptoJob: CRM компаній і API агентів

Дата: 2026-09-12. Стан: чернетка на затвердження власником.
Обов'язкові джерела: `docs/contracts.md` (ролі, ідентичності, формула, §7 номери міграцій, §8 ключі, яких немає),
`db/migrations/0001_core.sql`, `docs/specs/2026-09-12-release1-design.md` (розділи 3, 4, 5, 8).
Супутні файли цієї специфікації:
- `db/migrations/0003_crm.sql`, `db/migrations/0004_billing.sql` (не накочено);
- `docs/api/openapi.yaml` (OpenAPI 3.1, перевірено `redocly lint`);
- `docs/api/mcp-tools.md` (інструменти MCP 1:1 з REST).

Стек: Next.js 16 App Router на Cloudflare Workers (OpenNext), D1, Tailwind v4 + shadcn/ui, TypeScript.
Інтерфейс англійською. Рядки інтерфейсу в цьому документі взято в лапки. Довгого тире (U+2014) немає ніде:
ні в інтерфейсі, ні в листах, ні в повідомленнях бота, ні в текстах помилок API.

Обсяг: тиждень роботи невеликої команди (етап 3 плану, 28.09–04.10). Усе, що позначено «later», у тиждень не входить.

---

## 1. Десять головних рішень

| № | Рішення | Чому |
|---|---|---|
| 1 | Компанія бачить **анонімний профіль**: бали вибраних ролей, рівень, пояснення по джерелах (лише бали джерел 0–100), ролі, віддалено/місто, зарплатну межу, мережі, позначки перевірки, покриття. Ніяких імен, ніків, адрес, сирих фактів, пошти. Контакт лише через знайомство | CO-9, GDPR (мінімізація); ніки й кількість підписників деанонімізують миттєво |
| 2 | Видимість перевіряється **наживо в кожному запиті** одним SQL-фрагментом: `visible_to_companies = 1` + чинна згода `visibility`. Кеша профілів немає | Вимкнення видимості діє миттєво, без фонових задач |
| 3 | **x402 це спосіб оплати, ключ API це особа.** Без ключа можна лише шукати (анонімні результати). Знайомство завжди від компанії з акаунтом, тож кандидат знає, хто питає | Анонімні запити на знайомство були б спамом і порушували б прозорість для кандидата |
| 4 | **Один реєстр дій** (`lib/crm/actions.ts`: zod-вхід, zod-вихід, право, ціна, квота, дія журналу) обслуговує server actions інтерфейсу, маршрути REST і інструменти MCP | Паритет «агент уміє все, що CRM» гарантує код, а не дисципліна; тест звіряє з `openapi.yaml` |
| 5 | **Власна тонка обгортка x402** поверх `x402ResourceServer` з `@x402/core` для REST і MCP. `@x402/mcp` (SDK v1) і `agents/x402` (лише EVM) не беремо | `agents@0.23` працює на MCP SDK v2; нам потрібні Solana і динамічна ціна (підписка = безкоштовно) |
| 6 | Розрахунок x402: **до ефекту** для знайомства (verify → settle → створити → сповістити), **до відповіді** для пошуку (verify → пошук → settle → віддати). Хеш платежу унікальний: один платіж = один запит | Сповіщення людини не відкотиш; дані без оплати не віддаємо |
| 7 | Воронка: одна картка на пару (компанія, кандидат). Етапи `intro_requested` і `contact_shared` ставить лише процес знайомства; `interview` і `hired` потребують відкритого контакту; прострочене знайомство повертає картку в `found` | Етапи не можуть брехати про стан контакту |
| 8 | **Без масового вивантаження**: сторінка 20, не більше 10 сторінок на запит, денні квоти на пошук, перегляди, знайомства; жодного CSV | CO-9, умови для компаній |
| 9 | Оплата: Stripe Checkout (підписка, 14 днів пробного, Stripe Tax, VAT ID) + Customer Portal; **USDC як x402-платіж $100 за 30 днів**; ручний доступ від адміна. Хто має доступ, каже одне SQL-подання `company_access` | Stripe stablecoin для ЄС у закритій беті; x402 уже є, окремий спостерігач мережі не потрібен |
| 10 | Вебхук: один на компанію, підпис `NCJ-Signature: t=…,v1=HMAC-SHA256`, **секрет не зберігається** (виводиться з `WEBHOOK_SIGNING_KEY` і id компанії), стан доставки лежить у рядку `intros`, повтори робить cron; запасний шлях це опитування `list_intros?updated_since=` | Жодних секретів у D1 і жодної нової таблиці поза §7 |

Ще три рішення, менші:
- Член команди компанії це звичайний рядок `users` з тим самим входом поштою або Telegram (0002). Членство в `company_members`.
- Вакансії компаній бачить рушій добірки через подання `company_jobs_live` (лише компанії з підпискою), не більше однієї вакансії компанії в добірці на 5.
- Пости в X-акаунт @nextcryptojob лише ручні: черга в адмінці («API X не використовуємо», spec §8).

---

## 2. Актори й права

### 2.1 Актори
| Актор | Як з'являється | Як ідентифікується |
|---|---|---|
| owner | створив компанію або підвищений іншим owner | сесія 0002 + `company_members.role = 'owner'` |
| member | прийняв запрошення | сесія 0002 + `company_members.role = 'member'` |
| agent | запит із ключем `ncj_live_…` | `api_keys.key_hash`; діє від імені компанії ключа |
| x402 guest | запит лише з `PAYMENT-SIGNATURE` | адреса платника з `verifyPayment` |
| admin | працівник NextCryptoJob | роль адміна з 0007 (поза цією специфікацією) |
| candidate | людина з 0001 | сесія або токен з листа (лише для відповіді на знайомство) |

### 2.2 Матриця прав
«✓» дозволено, «R» лише читання, «·» заборонено. Агент = ключ, створений власником; діє в межах доступу компанії.

| Дія | owner | member | agent | x402 guest | admin |
|---|---|---|---|---|---|
| Пошук кандидатів | ✓ | ✓ | ✓ | ✓ (платно) | · |
| Профіль кандидата | ✓ | ✓ | ✓ | · | · |
| Воронка: додати, етап, теги, нотатки, видалити картку | ✓ | ✓ | ✓ | · | · |
| Історія картки | ✓ | ✓ | ✓ | · | · |
| Запит на знайомство, скасування | ✓ | ✓ | ✓ | · | · |
| Вакансії: створити, змінити, закрити | ✓ | ✓ | ✓ | · | сховати/показати |
| Черга постів у X | · | · | · | · | ✓ |
| Збережені пошуки | ✓ | ✓ | ✓ | · | · |
| Вебхук: адреса, ротація, тест | ✓ | R | ✓ | · | · |
| Ключі API: створити, відкликати | ✓ | · | · | · | відкликати |
| Команда: запросити, прибрати, змінити роль | ✓ | · | · | · | · |
| Налаштування компанії | ✓ | R | · | · | ✓ (статус) |
| Оплата: Stripe Checkout, портал | ✓ | · | · | · | · |
| Оплата: USDC за місяць (x402) | ✓ | · | ✓ | · | · |
| Надати ручний доступ | · | · | · | · | ✓ |
| Журнал дій компанії | ✓ | R | · | · | R |
| Використання (usage) | ✓ | R | R | · | R |
| Закрити компанію | ✓ | · | · | · | ✓ |
| Схвалити заявку агенції, призупинити компанію | · | · | · | · | ✓ |

Адмін не бачить контактів кандидатів через CRM-маршрути і не входить «від імені» компанії (later).

### 2.3 Доступ компанії
`company_access.access` (подання в 0004):
- `subscription`: статус компанії `active` і є підписка `trialing`/`active` з неминулим `current_period_end`
  (Stripe: +2 доби запасу на запізнілий вебхук), або `past_due` не довше 7 діб.
- `pay_per_request`: компанія `active`, підписки немає. Працює лише API/MCP з оплатою x402 за пошук і знайомство;
  інтерфейс CRM показує воронку, знайомства, вакансії й налаштування лише для читання та сторінку оплати.
- `none`: компанія `pending_review`, `suspended`, `rejected` або `closed`.

---

## 3. Архітектура

### 3.1 Файли (у `web/`)
```
web/
  worker.ts                         власна точка входу OpenNext: fetch + scheduled (cron)
  wrangler.jsonc                    + triggers.crons, ratelimits (RL_API, RL_WEB, RL_IP)
  src/lib/crm/
    types.ts                        zod-схеми, що дзеркалять openapi.yaml#/components/schemas
    actions.ts                      реєстр дій: { name, rest, mcp, input, output, permission, price, quota, audit }
    context.ts                      актор: сесія члена | ключ | гість x402; доступ компанії
    permissions.ts                  матриця з розділу 2.2
    quotas.ts                       денні й місячні квоти (usage_events) + ліміти сплесків (RL_*)
    audit.ts                        запис у audit_log (0002)
    visibility.ts                   SQL-фрагмент видимості, onVisibilityChanged, beforeCandidateErased
    project.ts                      білий список полів профілю, підписи джерел, мережі й роки ончейн
    search.ts  pipeline.ts  intros.ts  jobs.ts  saved-searches.ts  webhooks.ts
    notify.ts                       листи й повідомлення бота (кандидату і компанії)
  src/lib/x402/
    server.ts                       x402ResourceServer: фасилітатор і мережі за оточенням
    http.ts                         обгортка REST: 402, PAYMENT-SIGNATURE, PAYMENT-RESPONSE
    mcp.ts                          обгортка MCP: _meta["x402/payment"], _meta["x402/payment-response"]
  src/lib/billing/stripe.ts  access.ts  usdc.ts
  src/lib/cron/index.ts             expireIntros, deliverWebhooks, savedSearchAlerts, closeExpiredJobs, purgeUsage
  src/app/api/v1/…/route.ts         28 операцій REST (тонкі: розбір → реєстр → відповідь)
  src/app/mcp/route.ts              createMcpHandler
  src/app/api/stripe/webhook/route.ts
  src/app/company/…                 сторінки CRM (розділ 10)
  src/app/intro/[id]/page.tsx       відповідь кандидата на знайомство
  src/app/jobs/[id]/page.tsx        публічна сторінка живої вакансії компанії
```

### 3.2 Реєстр дій
Кожна дія описана один раз:
```ts
defineAction({
  name: "request_intro",
  rest: { method: "POST", path: "/intros", status: 201 },
  mcp: { tool: "request_intro", annotations: { openWorldHint: true } },
  input: IntroCreate, output: Intro,
  permission: ["owner", "member", "agent"],           // розділ 2.2
  access: ["subscription", "pay_per_request"],        // розділ 2.3
  price: { pay_per_request: "5.00" },                 // x402, лише коли немає підписки
  quota: ["request_intro_day", "request_intro_month"],
  audit: "intro.request",
  settle: "before_effect",                            // розділ 7.4
  handler: async (ctx, input) => { … },
});
```
Server actions інтерфейсу викликають `runAction(name, input, sessionCtx)`; маршрут REST і інструмент MCP
роблять те саме з іншим контекстом. Помилки: `class ActionError { code; status; details }` з кодами з
`openapi.yaml#/components/schemas/Error`.

### 3.3 Визначення актора
1. `Authorization: Bearer ncj_live_…` → SHA-256 → `api_keys` за `key_hash` (`revoked_at IS NULL`) → компанія.
   `last_used_at` оновлюємо не частіше 1 разу на 5 хв (менше записів у D1).
2. Інакше сесія 0002 → `company_members` (поточна компанія з кукі `ncj_company`, інакше перша за `last_seen_at`).
3. Інакше `PAYMENT-SIGNATURE` → гість x402 (лише `search_candidates`).
4. Інакше 401.
Після зміни поточної компанії або входу в інтерфейсі викликати `router.refresh()` (кеш роутера Next).

### 3.4 Правило видимості (єдиний SQL-фрагмент)
```sql
u.visible_to_companies = 1
AND EXISTS (SELECT 1 FROM consents c WHERE c.user_id = u.id AND c.kind = 'visibility' AND c.revoked_at IS NULL)
-- для запитів компанії ще два рядки:
AND NOT EXISTS (SELECT 1 FROM intros b WHERE b.company_id = :company AND b.user_id = u.id AND b.candidate_blocked = 1)
AND NOT EXISTS (SELECT 1 FROM company_members m WHERE m.company_id = :company AND m.user_id = u.id)
```
Кандидат, що заблокував компанію, для неї виглядає як невидимий (без підказки, що саме блок).
Член команди не бачить себе в пошуку своєї компанії.

Бал показуємо, лише коли версія формули пройшла ворота якості (spec §6.3, «без 1.7 бал не показуємо»):
`EXISTS (SELECT 1 FROM quality_runs q WHERE q.formula_version = s.formula_version AND q.passed = 1)`.
Інакше роль вважається непорахованою з причиною `not_published`.

### 3.5 Час, id, D1
- Час у D1: `datetime('now')` (UTC, `YYYY-MM-DD HH:MM:SS`); в API ISO 8601 з `Z`. Stripe дає секунди Unix: `datetime(?, 'unixepoch')`.
- Публічні id: префікс + 20 символів base62 з `crypto.getRandomValues` (`co_`, `job_`, `int_`, `ss_`, `app_`, `sub_`, `key_`, `pay_`).
- `candidate_id` = `users.id` (uuid v4, нічого не розкриває). Мітка для людей: `"#" + перші 6 hex id у верхньому регістрі`.
- D1 має межу 100 зв'язаних параметрів на запит: списки id передаємо одним параметром JSON і `json_each(?1)`.
- Групові записи (кілька UPDATE/INSERT однієї дії) через `DB.batch([...])`: це одна транзакція.

### 3.6 Cron (власна точка входу OpenNext)
За https://opennext.js.org/cloudflare/howtos/custom-worker :
```ts
// web/worker.ts
import { default as handler } from "./.open-next/worker.js";
import { runCron } from "./src/lib/cron";
export default {
  fetch: handler.fetch,
  async scheduled(event, env, ctx) { ctx.waitUntil(runCron(event.cron, env)); },
} satisfies ExportedHandler<CloudflareEnv>;
```
`wrangler.jsonc`: `"main": "worker.ts"`, `"triggers": { "crons": ["*/5 * * * *", "0 * * * *"] }`.
| Розклад | Задачі |
|---|---|
| кожні 5 хв | `expireIntros`, `deliverWebhooks` |
| щогодини | `savedSearchAlerts` (кожен пошук не частіше разу на 24 год), `closeExpiredJobs`; о 03:00 UTC ще `purgeUsage` (старші 400 днів) |
Кожна задача обробляє обмежену пачку (до 200 рядків) і добирає решту наступним запуском.

---

## 4. Модель даних

Таблиці рівно з `docs/contracts.md` §7. Повні визначення в міграціях; тут те, що не видно з SQL.

### 4.1 0003_crm
| Таблиця | Суть | Каскад |
|---|---|---|
| `companies` | компанія або агенція; статус; домен і його перевірка; умови; налаштування вебхука | видалення компанії видаляє все CRM-нижче |
| `company_members` | члени й запрошення (`user_id NULL` + `invite_email`) | за компанією і за людиною |
| `company_jobs` | вакансії; стан поста в X; лічильники показів і переходів | за компанією |
| `saved_searches` | фільтри + щоденне сповіщення; `seen_json` до 2 000 id | за компанією |
| `pipeline` | картка (компанія, кандидат), етап, теги, роль, вакансія | за компанією і за кандидатом |
| `pipeline_events` | історія: етапи, нотатки, теги, події знайомства, видимість | за карткою |
| `intros` | запит на знайомство, знімок контакту, стан доставки вебхука | за компанією і за кандидатом |
| `agency_applications` | заявка агенції | за компанією |

Також два індекси на таблицях ядра (лише індекси): `idx_scores_role_score`, `idx_users_visible`.
Перевірено на SQLite 3.51 (двічі накочено, план запиту пошуку йде індексом `idx_scores_role_score`,
унікальність відкритого знайомства, CHECK контакту, каскад видалення кандидата).

### 4.2 0004_billing
| Таблиця/подання | Суть |
|---|---|
| `subscriptions` | stripe / usdc / manual; для Stripe рядок перезаписується з `subscriptions.retrieve` |
| `api_keys` | лише хеш; префікс для показу |
| `x402_payments` | кожен платіж; `payload_hash` UNIQUE (повтор = 409); лишається після закриття компанії |
| `usage_events` | рядок на виклик; квоти рахуються з нього; 400 днів |
| `company_access` (VIEW) | `subscription` / `pay_per_request` / `none` |
| `company_jobs_live` (VIEW) | живі вакансії компаній з підпискою: для engine і `search_jobs` |

### 4.3 Що CRM чекає від 0002_auth (власник web: вхід)
- `sessions.user_id → users.id`.
- `consents(user_id, kind, granted_at, revoked_at)`, `kind IN ('score', 'visibility', 'contact')`,
  індекс `(user_id, kind)` (без нього пошук сканує `consents`, видно в плані запиту).
- `audit_log` з колонками (назви можна змінити, тоді адаптер у `lib/crm/audit.ts`):
  `id, created_at, actor_kind ('member','agent','x402_guest','admin','candidate','system'), actor_id,
  company_id, action, target_user_id, channel ('web','rest','mcp'), request_id, meta_json`;
  індекси `(company_id, created_at)` і `(target_user_id, created_at)`. Без FK на users: записи живуть після видалення акаунта
  (псевдонімний id, без особистих даних).

---

## 5. Дії і правила

### 5.1 Реєстр
| Дія | UI | REST | Квота | Ціна x402 | Журнал |
|---|---|---|---|---|---|
| `get_account` | шапка, дашборд | `GET /me` | · | · | · |
| `search_candidates` | Search | `POST /candidates/search` | `search_candidates` | $0.50 (гість, без підписки) | `candidate.search` (id результатів у meta) |
| `get_candidate` | профіль | `GET /candidates/{id}` | `get_candidate` | · | `candidate.view` |
| `list_pipeline` | Pipeline | `GET /pipeline` | · | · | · |
| `add_to_pipeline` | «Add to pipeline» | `PUT /pipeline/{id}` | · | · | `pipeline.add` |
| `update_stage` | «Move to…», теги | `PATCH /pipeline/{id}` | · | · | `pipeline.stage` / `pipeline.tags` |
| `remove_from_pipeline` | «Remove from pipeline» | `DELETE /pipeline/{id}` | · | · | `pipeline.remove` |
| `list_candidate_history` | вкладка History | `GET /pipeline/{id}/events` | · | · | · |
| `add_note` | поле нотатки | `POST /pipeline/{id}/notes` | · | · | `pipeline.note` |
| `request_intro` | «Request intro» / «Show Telegram handle» | `POST /intros` | `request_intro_day`, `request_intro_month` | $5.00 (без підписки) | `intro.request` або `contact.reveal` |
| `list_intros`, `intro_status` | Pipeline, профіль | `GET /intros`, `GET /intros/{id}` | · | · | · |
| `cancel_intro` | «Withdraw request» | `POST /intros/{id}/cancel` | · | · | `intro.cancel` |
| `list_jobs`, `get_job`, `post_job`, `update_job`, `close_job` | Jobs | `/jobs…` | · | · | · |
| `*_saved_search*` | Saved searches | `/saved-searches…` | · | · | · |
| `get_webhook`, `set_webhook`, `test_webhook` | Developers | `/webhook…` | · | · | · |
| `get_usage` | Developers > Usage | `GET /usage` | · | · | · |
| `buy_usdc_month` | Billing | `POST /billing/usdc-month` | · | $100.00 | · |
| `search_jobs` | (кандидати) | `GET /public/jobs` | RL_IP | · | · |

Журнал: кожна дія над кандидатом пише рядок `audit_log` (актор, компанія, канал, request_id).

### 5.2 Пошук кандидатів
Фільтри (`SearchFilters`): `role`, `min_score`, `min_level`, `max_level`, `chains` (хоч одна), `min_onchain_years`
(1/2/4/6), `work_mode` + `city`, `x_verified`, `wallet_verified`, `min_coverage`, `contact_direct`, `exclude_in_pipeline`.
Фільтрів за віком, статтю, походженням, мовою, фото немає, бо таких даних немає.

Сортування (усі за спаданням, далі `u.id` за зростанням як стабільний хвіст): `score` (типово), `level` (потім
покриття), `coverage`, `newest` (`consents.granted_at` згоди `visibility`). Непораховані й `NULL` завжди після
порахованих (`COALESCE(key, -1)`): відсутнє значення ніколи не випереджає справжнє.

Рівень з балу: `level = min(10, floor(score/10) + 1)`, тому `min_level = L` → `score >= 10·(L−1)`,
`max_level = L < 10` → `score < 10·L`.

Алгоритм (роль задана):
```sql
SELECT u.id, s.score, s.cover, s.breakdown_json, s.computed_at
FROM scores s JOIN users u ON u.id = s.user_id
WHERE s.role = :role
  AND EXISTS (SELECT 1 FROM json_each(u.roles) r WHERE r.value = s.role)   -- лише вибрані людиною ролі
  AND <видимість 3.4> AND <ворота якості 3.4>
  AND (:min_score IS NULL OR s.score >= :min_score) AND …                 -- рівні, покриття
  AND (:x_verified IS NULL OR EXISTS (SELECT 1 FROM identities i WHERE i.user_id = u.id AND i.kind = 'x' AND i.verified_at IS NOT NULL))
  AND (:wallet_verified IS NULL OR EXISTS (SELECT 1 FROM identities i WHERE i.user_id = u.id
        AND i.kind IN ('evm','solana') AND i.verified_via = 'signature'))
  AND <work_mode: 'remote' → u.remote_mode LIKE '%remote%'; 'city' → u.remote_mode LIKE '%city%' AND lower(trim(u.city)) = lower(trim(:city))>
  AND <contact_direct: u.contact_mode = 'direct' AND u.telegram_username IS NOT NULL AND згода 'contact'>
  AND <keyset з курсору: (key < :k) OR (key = :k AND u.id > :id)>
ORDER BY COALESCE(s.score, -1) DESC, u.id
LIMIT 200;
```
Без ролі: та сама вибірка з `LEFT JOIN` на найкращу вибрану роль (`MAX(score)` по `json_each(u.roles)`).
Мережі й роки ончейн (`chains`, `min_onchain_years`) у `breakdown_json` поки немає, тому пост-фільтр у TS:
для пачки з 200 id читаємо `source_facts` (`evm`, `solana`, `hyperliquid`) одним запитом через `json_each`,
рахуємо `deriveChains` і `onchainYears` (правила нижче), відкидаємо, добираємо наступну пачку, доки не набрано
21 рядок або переглянуто 2 000 рядків (тоді повертаємо, що є, і курсор).
- Мережа активна: EVM `sent > 0` або `firstTs` не null (на кожній з ethereum/base/arbitrum/optimism);
  Solana `sigs > 0`; Hyperliquid `fillsRecent > 0` або `volumeUsd > 0`.
- Роки ончейн: найраніший `firstTs` серед EVM і Solana без `sigsCapped` (як `ageYears` у формулі), вниз до 0/1/2/4/6.

Курсор: base64url JSON `{v, sort, k, id, page, fh}` з HMAC (ключ виводиться з `SESSION_SECRET` через HKDF, мітка `cursor`),
`fh` = хеш фільтрів. Змінені фільтри або підроблений курсор → `validation_failed`. Сторінка 11 → `page_cap_reached`.
Справжня межа вивантаження це денна квота, а не курсор.

Порожній результат завжди називає причину (`empty_reason`):
| Причина | Коли | Текст в інтерфейсі |
|---|---|---|
| `scores_not_published` | ворота якості для чинної формули не пройдено | "Scores are not published yet. We publish them once the formula passes our quality check." |
| `no_visible_candidates_for_role` | для ролі 0 видимих людей | "No visible candidates chose this role yet. Save the search and we will email you when someone does." |
| `filters_too_narrow` | для ролі є люди, фільтри всіх відсіяли | "No candidates match all filters. {n} visible candidates chose this role." + "Clear filters" |

Кожна сторінка пошуку: один рядок `usage_events`, один рядок `audit_log` (`candidate.search`, `meta_json.ids` до 20 id).

### 5.3 Профіль для компаній (білий список)
`project.ts` будує відповідь лише з цих полів; тест перевіряє, що ключі відповіді ⊆ білого списку і що в JSON немає
рядків, схожих на EVM-адресу (`0x[0-9a-f]{40}`), base58 32–44, `@` пошти.
| Поле | Звідки | Показ |
|---|---|---|
| `roles[]` | `users.roles` × `scores` | лише вибрані ролі; бал цілим, рівень, покриття |
| `unscored_reason` | `breakdown_json.reason`, contracts §1, ворота | "Not scored: needs GitHub", "Not scored yet: needs a CV", "Not scored yet: needs a portfolio", "Scores are not published yet", "Score is being calculated" |
| `breakdown.core/bonus` | `breakdown_json.core/bonus` | бал джерела цілим, вага або максимум |
| `breakdown.gaps` | `breakdown_json.gaps` | лише "{Source} data unavailable right now"; внутрішні причини (`not configured: …`) не показуємо |
| `work`, `salary_floor` | `remote_mode`, `city`, `salary_min`, `salary_currency` | як ввела людина |
| `chains`, `onchain_years` | `source_facts` (5.2) | назви мереж, відро років |
| `badges` | `identities` | "X verified"; "Wallet verified by signature" / "Wallet not signature-verified"; "GitHub linked", "YouTube linked", "Site linked" |
| `contact_mode` | `users.contact_mode` + згода `contact` + наявність Telegram | "Contact after approval" / "Telegram handle available" |
| `contact` | `intros.contact_*` | лише після «так» або відкриття в режимі direct |

Не показуємо ніколи: email (крім знімка контакту), `telegram_username` (крім знімка), `target_text`, ніки й адреси
з `identities`, `facts_json`, `last_active_at`, дату створення акаунта.

Підписи джерел (`label`): `gh_eng` "Open-source engineering (GitHub)", `gh_builder` "Shipping projects (GitHub)",
`x` "Reach and engagement on X", `yt` "YouTube channel", `media` "Media reach (stronger of X and YouTube)",
`output` "Published work (site or GitHub)", `onchain` "Onchain history", `trading` "Trading activity",
`site` "Personal site or blog". Посилання "How scores work" веде на публічну сторінку формули (spec §8, GDPR ст. 22).

### 5.4 Воронка
Етапи в інтерфейсі: "Found" → "Intro requested" → "Contact shared" → "Interview" → "Hired" / "Declined".

| Перехід | Хто | Умова |
|---|---|---|
| (немає) → `found` | член, агент | `add_to_pipeline`; кандидат видимий |
| `found` → `intro_requested` | система | створено знайомство в режимі approval |
| будь-який → `contact_shared` | система | «так» кандидата або відкриття в режимі direct |
| `intro_requested` → `declined` (`declined_by = candidate`) | система | «ні» кандидата |
| `intro_requested` → `found` | система | прострочення (14 днів) або скасування компанією |
| будь-який (крім `intro_requested`) → `found` / `declined` (`company`) | член, агент | вручну |
| `contact_shared`/`interview`/`hired` ↔ `interview`/`hired` | член, агент | контакт відкрито |
| `intro_requested` → щось вручну | · | `invalid_stage_transition`: "Withdraw the pending intro first." |
| → `interview`/`hired` без контакту | · | `contact_not_shared`: "Contact is not shared yet. Request an intro first." |

Кожен перехід: рядок `pipeline_events` + `audit_log`, `stage_changed_at`, `updated_at`.
Теги: до 10, до 32 символів, без розрізнення регістру, зберігаються як ввели. Нотатки: лише додавання (редагування later).
Видалення картки: скасовує відкрите знайомство, видаляє картку й історію (журнал лишається).

### 5.5 Знайомства
Стани: `pending` → `accepted` | `declined` | `expired` | `canceled`; окремо `direct`.

Створення (`request_intro`), усе перевіряємо **до** оплати:
1. Кандидат видимий для компанії (3.4), інакше `candidate_not_visible` (409) або `candidate_not_available` (404).
2. Немає відкритого (`intro_already_open`), немає відмови за 90 днів і не більше 2 запитів за 90 днів (`intro_cooldown`, `details.retry_after`).
3. Квоти (розділ 9). Повідомлення 20–600 символів; `job_id` лише своя відкрита вакансія.
4. Режим: `direct`, якщо `contact_mode = 'direct'`, є `telegram_username` і чинна згода `contact`; інакше `approval`.
5. Оплата x402, якщо компанія без підписки: verify → settle (розділ 7.4).
6. `DB.batch`: INSERT `intros` (`expires_at = +14 днів`, токен відповіді: 32 байти, у БД SHA-256), картка → `intro_requested`
   (або `contact_shared` зі знімком контакту для direct), `pipeline_events`, `audit_log`, `usage_events`.
7. Сповіщення кандидату в його канал (`users.channel`); якщо Telegram не доставив (бот заблоковано), то пошта, якщо є.
   Не вдалося зовсім: `notify_error`, знайомство живе далі, компанія бачить "We could not reach the candidate yet."

Повідомлення кандидату в Telegram (кнопки inline, `callback_data` = `ia:<intro_id>`, `id:<intro_id>`, `ib:<intro_id>`):
```
{Company} wants to talk to you about a {Role} role.

"{message}"

Job: {Job title} (nextcryptojob.xyz/jobs/{job_id})
Company site: {domain} (domain verified)
This request expires on {date}.

[ Accept ]  [ Decline ]
[ Decline and block this company ]
```
Лист: тема "{Company} wants to talk to you", той самий текст, кнопка "Review the request" →
`/intro/{id}?t={token}`. Сторінка відповіді показує, що саме буде відкрито:
"If you accept, {Company} will see your Telegram handle @alice. They will not see your email or wallets."
(або "…will see your email address a***@gmail.com." якщо Telegram немає). Кнопки: "Accept and share my Telegram"
/ "Decline" / посилання "Decline and block this company". Дія лише POST (сканери пошти відкривають GET);
токен одноразовий і діє до `expires_at`; із сесією кандидата токен не потрібен.

Відповідь (одна транзакція, `UPDATE … WHERE id = ? AND status = 'pending'`, перевірка `changes = 1` проти подвійного натискання):
- «Accept»: `accepted`, знімок `contact_kind/value` (Telegram-нік, інакше пошта), картка → `contact_shared`,
  вебхук `intro.accepted` у чергу, лист/повідомлення тому, хто просив (агентові: власникам):
  "Candidate #3F9A1C accepted your intro request. Open the pipeline to see the contact." (контакт у листі не пишемо).
- «Decline»: `declined`, картка → `declined` (`candidate`), вебхук `intro.declined`. «Decline and block»: ще `candidate_blocked = 1`.
- Бот відповідає кандидату: "Done. {Company} can now see your Telegram handle." / "Declined. {Company} will not contact you."

Режим direct: кандидат отримує повідомлення "{Company} viewed your Telegram handle." (прозорість), без кнопок.
Скасування компанією: `canceled`, картка → `found`; кандидат, що відкриє посилання, бачить "This request was withdrawn."
Прострочення: cron кожні 5 хв (`idx_intros_expiry`), `expired`, картка → `found` (якщо досі `intro_requested`),
вебхук `intro.expired`, лист тому, хто просив: "No answer from #3F9A1C in 14 days."
Нагадування кандидату на 7-й день: later (колонка `reminded_at` уже є).

### 5.6 Вакансії компаній
- Стани: `draft` → `open` → `closed`. Відкрита вимагає `apply_url` (`https://` або `mailto:`), живе 60 днів
  (`expires_at`), cron закриває прострочені й пише власнику "Your job "{title}" expired. Reopen it to keep it in digests."
- Жива (`company_jobs_live`) = відкрита, не прихована адміном, не прострочена, компанія з підпискою.
- Добірка (engine, 0006): вакансія компанії йде кандидату, якщо `roles` перетинаються з його ролями і збігається місце
  (remote ↔ remote; місто = те саме місто). Не більше **однієї** вакансії компанії в добірці на 5; ніколи повторно
  тій самій людині. Позначка в добірці: "Posted by {Company} on NextCryptoJob". Engine збільшує `digest_shown`.
  Компанія бачить лише лічильники, не хто отримав.
- Публічна сторінка `/jobs/{job_id}` (лише для живої): назва, компанія, опис, зарплата, "Apply" →
  `/jobs/{id}/apply` (+1 до `apply_clicks`, редірект на `apply_url`). Не жива → 404 "This job is closed."
- X: галочка "Post on @nextcryptojob (reviewed by our team)" → `x_post_state = 'queued'`, текст за шаблоном до 280 символів:
  `{Company} is hiring: {Title} ({Remote | City}). {Salary if set} Apply: nextcryptojob.xyz/jobs/{id}`.
  Адмін копіює, публікує вручну, вставляє посилання ("Mark as posted") або "Skip". Закриття вакансії знімає з черги.
- Модерація: публікуємо одразу для компаній з підпискою; адмін може сховати (`hidden_by_admin_at`).

### 5.7 Збережені пошуки і сповіщення
- До 20 на компанію (у пробному 5). Спільні для всієї команди; сповіщення отримує той, хто створив
  (агентські: власники) у свій канал.
- При створенні поточні збіги (до 200) записуються в `seen_json`, тож перше сповіщення лише про нових.
- Cron щогодини бере пошуки з `alert = 'daily'` і `last_alert_at` старше 24 год, виконує пошук (до 200, без квоти
  й без x402), нові id = збіги мінус `seen_json`. Є нові → лист/повідомлення:
  "3 new candidates match "Solidity engineers, remote"" + кнопка "Open search". Потім `seen_json` (обрізаємо до 2 000
  найновіших), `last_alert_at`, `last_match_count`. Кандидати, що зникли, лишаються в `seen_json`, доки їх не витисне обрізання.
- Компанія без доступу `subscription`: сповіщення на паузі.

---

## 6. Команда, онбординг, агенції

### 6.1 Реєстрація компанії
1. `/company` (публічна): "Hire crypto talent by what they have shipped", "Get started", "Recruiting agency? Apply".
2. Вхід поштою або Telegram (0002) → `/company/start`: "Company name", "Website", "Country",
   "Who are you hiring for?" ("Our own team" / "Our clients (recruiting agency)"),
   галочка "I agree to the Company Terms: hiring only, no resale, no bulk export." (`terms_version`, `terms_accepted_at`).
3. "Our own team" → компанія `active`, людина `owner` → `/company/billing?welcome=1` з трьома шляхами:
   "Start 14-day trial" (Stripe), "Pay 100 USDC for 30 days", "Continue with pay per request (API only)".
4. Домен: якщо пошта власника на домені сайту (або піддомені) і домен не з переліку безкоштовних поштових
   (gmail.com, outlook.com, hotmail.com, yahoo.com, proton.me, protonmail.com, icloud.com, gmx.*, mail.ru, ukr.net),
   ставимо `domain_verified_at`. Кандидат бачить "(domain verified)". Перевірка через DNS TXT: later.

### 6.2 Агенція
"Our clients (recruiting agency)" → компанія `kind = 'agency'`, `status = 'pending_review'` + форма:
"Contact name", "Work email", "Website", "Country", "Who do you recruit for?", "How many hires per quarter?",
"How will you use candidate profiles?", галочка "We will not resell or share candidate data outside a hiring process."
Після подачі: "Application received. We review applications within 2 business days." Поки `pending_review`,
усі сторінки CRM показують цю плашку, доступні лише налаштування. Адмін: "Approve" (компанія `active`, лист
"Your agency account is approved"), "Ask for more info" (`needs_info` + `reviewer_note`, форма знову відкрита),
"Reject" (`rejected` + причина). Агенції в запиті на знайомство мають обов'язкове поле "Hiring for" (назва клієнта
або "Confidential client"), яке бачить кандидат.

### 6.3 Команда
Власник запрошує поштою ("Invite teammate"): рядок з `invite_email` і хешем токена, лист "{Name} invited you to
{Company} on NextCryptoJob" з посиланням `/company/join?t=…` (7 днів). Прийняти може лише людина, що ввійшла з
цією поштою. До 5 членів (розділ 9). Власник може зробити іншого власником, прибрати члена, змінити роль.
Останній власник не може піти чи видалити акаунт: "Make someone else an owner or close the company first."
Прибраний член втрачає доступ з наступного запиту; його нотатки лишаються з підписом "Former member".

---

## 7. Агенти: REST, MCP, x402, вебхук

### 7.1 REST
- База: `https://nextcryptojob.xyz/api/v1`. Повний договір: `docs/api/openapi.yaml` (28 операцій).
- Тіло помилки: `{ "error": { "code", "message", "request_id", "details"? } }`; 402 віддає об'єкт x402.
- Заголовки: `X-Request-Id` завжди; для дій з квотою `RateLimit-Limit`, `RateLimit-Remaining`, `RateLimit-Reset`
  (денна квота дії, UTC); на 429 ще `Retry-After`.
- Ліміт сплесків через Workers Rate Limiting (`env.RL_API.limit({ key })`, період 10 або 60 с; лічильник локальний
  для локації і приблизний, тому він лише від сплесків, а квоти рахуємо в D1):
  https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Версія в шляху (`/v1`); поля лише додаємо; ламаючі зміни будуть у `/v2`.

### 7.2 MCP
- `web/src/app/mcp/route.ts`:
  ```ts
  import { createMcpHandler } from "agents/mcp/server";
  const handler = createMcpHandler(async ({ requestInfo }) => buildServer(await resolveActor(requestInfo)), {
    route: "/mcp",
    allowedHostnames: ["nextcryptojob.xyz", "localhost"],
    allowedOriginHostnames: ["nextcryptojob.xyz", "localhost"],
  });
  const serve = (req: Request) => handler.fetch(req);
  export { serve as GET, serve as POST, serve as DELETE, serve as OPTIONS };
  ```
- `agents@0.23.0`, `@modelcontextprotocol/server@2.0.0` (MCP SDK v2), `zod` 4. Factory, а не готовий сервер:
  новий `McpServer` на кожен запит (так вимагає документація). `McpAgent` застарів, не беремо.
  https://developers.cloudflare.com/agents/api-reference/mcp-handler-api/
- Інструменти реєструються з реєстру дій (`server.registerTool(name, { inputSchema, outputSchema, annotations }, cb)`),
  список і схеми: `docs/api/mcp-tools.md`. Без ключа видно лише `search_jobs` і `search_candidates`.
- Потрібен `nodejs_compat` (є у `wrangler.jsonc`).

### 7.3 x402: налаштування
| Що | Значення |
|---|---|
| Пакети | `@x402/core@2.25.0` (`x402ResourceServer`, `HTTPFacilitatorClient`, `encode/decodePayment*Header` з `@x402/core/http`), `@x402/evm` (`ExactEvmScheme`), `@x402/svm` (`ExactSvmScheme`, peer `@solana/kit`) |
| Мережі, `X402_NETWORK=mainnet` | `eip155:8453` (USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`, EIP-712 `name: "USD Coin"`, `version: "2"`), `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` (USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`) |
| Мережі, `X402_NETWORK=testnet` | `eip155:84532` (USDC `0x036CbD53842c5426634e7929541eC2318f3dCF7e`, `name: "USDC"`), `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` (USDC `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`) |
| Фасилітатор | CDP `https://api.cdp.coinbase.com/platform/v2/x402` (Base: exact; Solana: exact; 1 000 транзакцій на місяць безкоштовно, далі $0.001); JWT з `CDP_API_KEY_ID`/`CDP_API_KEY_SECRET` через `createAuthHeaders` (заголовки по шляхах `verify`, `settle`, `supported`). Тест: `https://x402.org/facilitator` (лише тестові мережі). Запас: PayAI `https://facilitator.payai.network` (рішення власника) |
| Суми | USDC 6 знаків: $0.50 = `"500000"`, $5 = `"5000000"`, $100 = `"100000000"` |
| Отримувачі | `X402_PAY_TO_EVM`, `X402_PAY_TO_SOLANA` |
| Без ключів | прод без `CDP_API_KEY_*` або без адрес отримувача: x402 вимкнено, гість отримує 401 `not_configured` з текстом "not configured: CDP_API_KEY_ID"; розробка: testnet через x402.org |

CDP JWT на Workers: спершу перевірити `generateJwt` з `@coinbase/cdp-sdk/auth` у збірці OpenNext; якщо тягне Node-залежності,
підписати JWT самим (`jose`, Ed25519/ES256 через WebCrypto) за https://docs.cdp.coinbase.com/api-reference/v2/authentication .

### 7.4 x402: потік запиту
```
1. Дія платна для цього актора? (гість; або компанія pay_per_request для search/intro; або buy_usdc_month)
   ні → звичайний шлях
2. Немає PAYMENT-SIGNATURE (REST) / _meta["x402/payment"] (MCP)
   → reqs = rs.buildPaymentRequirements({ scheme: "exact", network, payTo, price }) для обох мереж
   → pr = rs.createPaymentRequiredResponse(reqs, { url, description, mimeType: "application/json", serviceName: "NextCryptoJob" })
   → REST: 402, заголовок PAYMENT-REQUIRED = base64(pr), тіло = pr, Cache-Control: no-store
     MCP: { isError: true, structuredContent: pr, content: [text] }
3. Є платіж → decode → payload_hash = sha256(канонічний JSON)
   → INSERT x402_payments(status='verified', …) ; конфлікт UNIQUE → 409 payment_reused
     (виняток: той самий payment-identifier і той самий payload → повернути попередній результат)
   → rs.verifyPayment(payload, matchedRequirements) ; невалідний → 402 з error
4. Усі перевірки дії (видимість, кулдауни, квоти, валідація) ДО розрахунку.
5a. settle "before_effect" (request_intro, buy_usdc_month): rs.settlePayment → success → виконати дію
5b. settle "before_response" (search_candidates): виконати пошук → rs.settlePayment → success → віддати
6. Невдалий settle → 402 + PAYMENT-RESPONSE {success:false,…}, без даних; x402_payments.status='failed'
7. Успіх → x402_payments.status='settled', tx, settled_at; usage_events(billing='x402')
   REST: заголовок PAYMENT-RESPONSE = base64(settle) ; MCP: _meta["x402/payment-response"] = settle
```
Захист від повтору: EIP-3009 nonce у мережі (контракт USDC відкидає повтор) + наш UNIQUE `payload_hash`
+ UNIQUE `(network, tx)`. Специфікація: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md ,
розширення ідемпотентності: https://github.com/x402-foundation/x402/blob/main/specs/extensions/payment_identifier.md .
Якщо settle пройшов, а дія впала (збій D1): 500 з `details.payment_id`, платіж лишається `settled`, адмін бачить його
в списку "Paid without result" і вирішує про повернення (питання власнику 8).

### 7.5 USDC-підписка через x402
`buy_usdc_month` ($100, лише з ключем): новий рядок `subscriptions` (`provider = 'usdc'`, `status = 'active'`,
`current_period_start = max(now, кінець чинного usdc-періоду)`, `current_period_end = start + 30 днів`,
`last_x402_payment_id`). За 3 дні до кінця лист власнику "Your USDC access ends on {date}." Автосписання немає.
В інтерфейсі сторінка оплати показує, як заплатити агентом або x402-клієнтом (приклад `curl` і MCP);
оплата гаманцем у браузері (`@x402/paywall`): later.

### 7.6 Вебхук
- Один URL на компанію (`companies.webhook_url`), лише `https://`, не IP-літерал, не `localhost`. Приватні адреси
  блокує прапор `global_fetch_strictly_public` (уже в `wrangler.jsonc`); DNS-перевірки в Worker не робимо.
- Секрет: `whsec_` + base64url(HMAC-SHA256(`WEBHOOK_SIGNING_KEY`, `"{company_id}:{webhook_secret_version}"`)).
  Показуємо при першому встановленні й після ротації; у БД немає. Ротація: версія +1, `webhook_rotated_at`;
  24 год шлемо обидва підписи: `v1=<новий>,v1=<старий>`.
- Запит: `POST`, `Content-Type: application/json`, `User-Agent: NextCryptoJob-Webhooks/1`,
  `NCJ-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + сире тіло)>`, `NCJ-Event-Id: evt_<intro_id>_<status>`,
  `NCJ-Event-Type`, `NCJ-Delivery-Attempt`. Тіло: `IntroWebhookEvent` з `openapi.yaml` (`intro.accepted` містить контакт).
- Отримувач має перевірити підпис сталочасовим порівнянням і відкинути `|now − t| > 300 с`.
- Доставка: одразу після зміни стану (у `ctx.waitUntil`, таймаут 10 с); невдача → `webhook_state = 'pending'`,
  `webhook_next_at` за розкладом 1 хв, 5 хв, 30 хв, 2 год, 12 год (6 спроб разом), далі `failed`,
  `companies.webhook_failing_since`, лист власнику "Your webhook is failing" і плашка в інтерфейсі.
  Cron `deliverWebhooks` бере `idx_intros_webhook`. Вебхук вимкнено або не задано → `webhook_state = 'none'`.
- Без `WEBHOOK_SIGNING_KEY`: `set_webhook` → 503 `not_configured` ("not configured: WEBHOOK_SIGNING_KEY"), опитування працює.

---

## 8. Оплата карткою (Stripe)

Перевірено 2026-09-12 (посилання в розділі 15). `stripe@22.6.2`, API `2026-08-26.dahlia`.
- Клієнт на Workers: `new Stripe(env.STRIPE_SECRET_KEY, { httpClient: Stripe.createFetchHttpClient() })`
  (v22 вимагає `new`; приклад OpenNext застарів).
- Ціна: один Price `STRIPE_PRICE_ID` $100/міс з `currency_options.eur` і `tax_behavior: "exclusive"` для обох валют;
  Checkout сам обирає валюту за IP.
- "Start 14-day trial" / "Subscribe" → server action → Checkout Session:
  `mode: "subscription"`, `line_items: [{ price, quantity: 1 }]`, `client_reference_id: company_id`,
  `subscription_data: { trial_period_days: 14, metadata: { company_id } }` (пробний лише раз на компанію),
  `automatic_tax: { enabled: true }`, `tax_id_collection: { enabled: true }`, `billing_address_collection: "required"`,
  `customer_email` (перший раз) або `customer` + `customer_update: { address: "auto", name: "auto" }`,
  `payment_method_collection: "always"` (картка на пробний; див. питання 1), `success_url`, `cancel_url`.
- "Manage billing" → `stripe.billingPortal.sessions.create({ customer, return_url })` (скасування, картка, рахунки, VAT ID).
- Вебхук `/api/stripe/webhook`: `await req.text()`, `stripe.webhooks.constructEventAsync(body, sig, STRIPE_WEBHOOK_SECRET,
  undefined, Stripe.createSubtleCryptoProvider())`. Події: `checkout.session.completed`,
  `customer.subscription.created|updated|deleted|trial_will_end|paused|resumed`, `invoice.paid`, `invoice.payment_failed`,
  `invoice.payment_action_required`, `invoice.finalization_failed`. На кожну: знайти id підписки
  (`session.subscription`, `subscription.id` або `invoice.parent.subscription_details.subscription`),
  `stripe.subscriptions.retrieve(id)` і перезаписати рядок: `status`, `items.data[0].current_period_start/end`
  (з версії basil їх немає на самій підписці), `trial_end`, `cancel_at`, `canceled_at`, `customer`, ціна, валюта.
  Порядок і дублікати подій тоді не мають значення. Відповідь 200 швидко.
- `trial_will_end` → лист "Your trial ends on {date}."; `invoice.payment_failed` → плашка "Payment failed. Update your card."
- Stripe Tax: зворотне нарахування ПДВ для B2B з VAT ID ЄС поза Францією; французьким клієнтам ПДВ Франції.
  Реєстрацію FR додати в Stripe Tax.
- Stripe stablecoin для підписок у ЄС закрито (приватна бета), тому USDC лише через x402 (7.5).
- Без `STRIPE_SECRET_KEY`: кнопки картки показують "Card payments are coming soon"; адмін дає ручний доступ
  (`provider = 'manual'`, `status = 'trialing'` або `'active'`, `current_period_end`, `note`).

---

## 9. Квоти й ліміти (пропозиція, підтверджує власник)

| | Підписка | Пробний (14 днів) | Без підписки (ключ, x402) | Гість x402 |
|---|---|---|---|---|
| Пошук, сторінок на добу | 300 | 50 | 200 (по $0.50) | 50 на адресу платника |
| Перегляд профілів на добу | 200 | 50 | 100 | · |
| Знайомства на добу | 10 | 3 | 10 (по $5) | · |
| Знайомства на місяць | 40 | 5 за весь пробний | · | · |
| Збережені пошуки | 20 | 5 | · (потрібна підписка) | · |
| Відкриті вакансії | 10 | 2 | · | · |
| Члени команди | 5 | 5 | 2 | · |
| Ключі API | 5 | 2 | 5 | · |
| Сплески | 60/хв на ключ (`RL_API`), 120/хв на сесію (`RL_WEB`) | те саме | те саме | 10/хв на IP (`RL_IP`) |
| `search_jobs` | 30/хв на IP (`RL_IP`) | | | |

Добова межа за UTC. Місячна за періодом підписки (для manual і usdc за календарним місяцем).
Квоти рахуються `COUNT(*)` по `usage_events` (індекс `(company_id, action, created_at)`), лише успішні виклики (2xx).
Перевищення: 429 `daily_quota_exceeded` або 403 `quota_exceeded` (місячна), текст "Daily search limit reached. It resets at 00:00 UTC."

---

## 10. Інформаційна архітектура й екрани

### 10.1 Мапа
```
/company                          публічна сторінка для компаній
/company/start                    створення компанії або заявки агенції
/company/join?t=                  прийняти запрошення
/company/dashboard                дашборд                                    [W1]
/company/search                   пошук кандидатів                           [W2]
/company/candidates/[id]          профіль кандидата                          [W3]
/company/pipeline                 канбан                                     [W4]
  (діалог) Request intro                                                     [W5]
/company/saved-searches           збережені пошуки
/company/jobs, /jobs/new, /jobs/[id]
/company/team
/company/settings                 профіль компанії, домен, Activity log, Close company
/company/billing                  підписка, USDC, історія x402
/company/developers               API keys | Webhook | Usage | MCP             [W6]
/intro/[id]?t=                    відповідь кандидата                        [W5]
/jobs/[id]                        публічна сторінка вакансії
/admin/companies, /admin/agency-applications, /admin/x-queue, /admin/intros  (розділ 12)
```
Навігація зліва: "Dashboard", "Search", "Pipeline", "Saved searches", "Jobs"; нижче "Team", "Billing",
"Developers", "Settings". Угорі: назва компанії (перемикач, якщо їх кілька), плашки стану.
На ширині < 768 px навігація ховається в меню; канбан стає списком етапів з розгортанням.

Спільні стани:
- Завантаження: скелети shadcn `Skeleton` для списків і карток; кнопки з `useFormStatus` ("Sending…").
- Помилка дії: toast з текстом за кодом помилки; оптимістичний перенос картки відкочується.
- Помилка сторінки: "Something went wrong. Try again." + "Request ID: {id}".
- Немає доступу: "Your company does not have access yet." + "Go to billing"; `pending_review`: "Your application is under review.";
  `suspended`: "Your company account is suspended. Contact support@nextcryptojob.xyz."
- Плашки: "Trial: {n} days left", "Payment failed. Update your card.", "Your webhook is failing", "Read-only: no active subscription".

### 10.2 Екрани
**Дашборд** (W1). Показує: воронку по етапах, знайомства, що чекають (найближче прострочення), нові збіги збережених
пошуків, живі вакансії з показами за 7 днів, використання сьогодні, останні 10 подій воронки.
Порожньо (нова компанія): три кроки "Find candidates", "Save a search", "Post a job".

**Пошук** (W2). Панель фільтрів (5.2), сортування, список результатів, "Save search", "Load more".
Кожен рядок: мітка, головна роль з балом і рівнем, інші ролі чипами, позначки, місце, мережі, зарплатна межа,
режим контакту, кнопка "Add to pipeline" або чип етапу. Кінець: "You reached the end of this search (200 results).
Narrow the filters to see others." Порожньо: 5.2.

**Профіль** (W3). Шапка з головним балом і кнопками; вкладки ролей з поясненням по джерелах (смужки 0–100, вага,
додатки, прогалини); позначки; праворуч панель картки воронки (етап, теги, нотатки, історія) і знайомство.
Прихований кандидат: сіра шапка "Candidate is no longer visible", лише власні нотатки, історія й контакт, якщо був.

**Воронка** (W4). Шість колонок; картка: мітка, бал, теги, стан знайомства ("Expires in 5 days", "Contact shared",
"Candidate is no longer visible"). Перенос через меню "Move to…" (доступно з клавіатури); перетягування мишею later.
Фільтри: вакансія, тег. Порожньо: "Your pipeline is empty. Find candidates in Search and add them here."

**Запит на знайомство** (W5): діалог з полем повідомлення (20–600, лічильник), вибором вакансії й ролі, попереднім
переглядом того, що побачить кандидат, рядком квоти. Direct-режим: кнопка "Show Telegram handle" з підтвердженням
"The candidate will be told that {Company} viewed their handle."

**Збережені пошуки**: назва, короткий опис фільтрів, перемикач "Daily alert", останнє сповіщення, "Run", "Delete".
Порожньо: "Save a search to get a daily email about new matches."

**Вакансії**: список (стан, "Live" / "Not live: {reason}", покази, переходи, стан посту в X). Форма: "Title", "Roles",
"Work mode" ("Remote", "City"), "City", "Country", "Salary" (min, max, currency, "per year"/"per month"),
"Apply URL", "Description", "Tags", "Post on @nextcryptojob (reviewed by our team)", "Save draft", "Publish".
Причини "Not live": "Draft", "Expired", "Hidden by NextCryptoJob", "No active subscription".
Порожньо: "No jobs yet. Jobs you publish appear in daily digests of matching candidates."

**Команда**: таблиця (ім'я або пошта, роль, приєднався, востаннє), "Invite teammate", "Make owner", "Remove".
**Налаштування**: "Company name", "Website", "About" (бачать кандидати в запитах), "X handle", "Country",
стан домену, вкладка "Activity log" (журнал `audit_log` компанії: хто, що, коли, без даних кандидата крім мітки),
"Close company" з підтвердженням "Your subscription is canceled now, API keys stop working, pending intros are
withdrawn. Data is deleted after 30 days."
**Оплата**: стан ("Trial until…", "Active until…", "Past due"), "Start 14-day trial", "Manage billing",
"Pay 100 USDC for 30 days" (інструкція), таблиця платежів x402 (дата, дія, мережа, сума, посилання на транзакцію).
**Developers** (W6): ключі, вебхук, використання, вкладка "MCP" з готовим JSON налаштування клієнта.
Порожньо (ключі): "Create a key to let your agent search candidates and request intros."

### 10.3 Макети

**W1. Dashboard**
```
+----------------------------------------------------------------------------------------------+
| NextCryptoJob   [Acme Labs v]                               Trial: 9 days left  [Subscribe]  |
+--------------+-------------------------------------------------------------------------------+
| Dashboard    | Good morning, Dana                                                            |
| Search       |                                                                               |
| Pipeline     | +----------------+ +----------------+ +----------------+ +----------------+   |
| Saved search | | Pipeline       | | Intros waiting | | New matches    | | Usage today    |   |
| Jobs         | | Found       12 | | 3 pending      | | 5 new in 2     | | Search  13/300 |   |
|              | | Intro req.   3 | | next expires   | | saved searches | | Profiles 8/200 |   |
| Team         | | Contact      4 | | in 2 days      | |                | | Intros   1/10  |   |
| Billing      | | Interview    2 | |                | | [Open]         | | Month    6/40  |   |
| Developers   | | Hired        1 | | [View intros]  | |                | |                |   |
| Settings     | +----------------+ +----------------+ +----------------+ +----------------+   |
|              |                                                                               |
|              | Recent activity                                | Live jobs                    |
|              | . #3F9A1C accepted your intro        10:14     | Solidity engineer  312 shown |
|              | . Dana moved #A07C22 to Interview    09:02     |                     18 clicks|
|              | . Agent sourcing-bot added #19BE04   Yesterday | Growth lead (draft)          |
|              | . #77D0E1 declined                   Yesterday | [New job]                    |
+--------------+-------------------------------------------------------------------------------+
```

**W2. Search**
```
+----------------------------------------------------------------------------------------------+
| Search candidates                                    Sort: [Score v]   [Save search]         |
+---------------------------+------------------------------------------------------------------+
| Role      [Engineer    v] | 20 results, page 1                                               |
| Min score [ 60 ]          | +-------------------------------------------------------------+  |
| Level     [ 5 ] to [ 10 ] | | #3F9A1C  Engineer 81  Level 9  Coverage 100%                |  |
| Chains    [x] Base        | | Also: DevRel 55                                             |  |
|           [x] Ethereum    | | Remote . Base, Ethereum, Solana . 4+ years onchain          |  |
|           [ ] Solana      | | X verified . Wallet verified by signature . GitHub linked   |  |
|           [ ] Arbitrum    | | From 120,000 USD . Contact after approval [Add to pipeline] |  |
| Onchain   [Any years  v]  | +-------------------------------------------------------------+  |
| Work      (o) Remote      | +-------------------------------------------------------------+  |
|           ( ) City [    ] | | #A07C22  Engineer 76  Level 8  Coverage 80%                 |  |
| [x] X verified            | | Remote . Base . 2+ years onchain                            |  |
| [ ] Wallet verified       | | X verified . Wallet not signature-verified                  |  |
| [ ] Telegram available    | | Telegram handle available            [In pipeline: Found]   |  |
| [ ] Hide my pipeline      | +-------------------------------------------------------------+  |
| Min coverage [ 50 ]       |                          [Load more]                             |
| [Clear filters]           |                                                                  |
+---------------------------+------------------------------------------------------------------+
```

**W3. Candidate profile**
```
+----------------------------------------------------------------------------------------------+
| < Back to search                                                                             |
| #3F9A1C  Engineer 81 . Level 9 . Coverage 100%        [Add to pipeline] [Request intro]      |
| Remote . From 120,000 USD . Base, Ethereum, Solana . 4+ years onchain                        |
| X verified . Wallet verified by signature . GitHub linked . Site linked                      |
+-----------------------------------------------------------+----------------------------------+
| [Engineer 81] [DevRel 55]                                 | Pipeline: Found  [Move to... v]  |
|                                                           | Tags: solidity, lending  [+]     |
| Core                              weight            score | -------------------------------- |
| Open-source engineering (GitHub)      80  ########    85  | Add a note                       |
| Reach and engagement on X             20  #####       46  | [                              ] |
| Bonus (up to +10)                                         |                           [Save] |
| Onchain history                   max +5  #########   92  | -------------------------------- |
| Personal site or blog             max +5             n/a  | History                          |
|                                                           | Sep 30 Dana added to pipeline    |
| Data gaps: Solana data unavailable right now              | Sep 30 Dana: "Strong audits..."  |
| Updated Sep 28 . Formula v4 . How scores work             |                                  |
+-----------------------------------------------------------+----------------------------------+
```

**W4. Pipeline**
```
+----------------------------------------------------------------------------------------------+
| Pipeline                               Job: [All jobs v]  Tag: [Any v]                       |
+--------------+---------------+---------------+---------------+---------------+---------------+
| Found (12)   | Intro req. (3)| Contact (4)   | Interview (2) | Hired (1)     | Declined (2)  |
+--------------+---------------+---------------+---------------+---------------+---------------+
| #19BE04      | #3F9A1C       | #A07C22       | #5521FA       | #0B7E3D       | #77D0E1       |
| Engineer 72  | Engineer 81   | Trader 88     | DevRel 69     | BD 74         | by candidate  |
| solidity     | Expires in    | @a07_trades   | Call Oct 3    |               |               |
| [Move to...] | 12 days       | [Move to...]  | [Move to...]  |               | #C4410A       |
|              | [Withdraw]    |               |               |               | by company    |
| #E2F870      |               | #9D13B6       |               |               |               |
| Candidate is |               | Candidate is  |               |               |               |
| no longer    |               | no longer     |               |               |               |
| visible      |               | visible       |               |               |               |
|              |               | lee@proton.me |               |               |               |
+--------------+---------------+---------------+---------------+---------------+---------------+
```

**W5. Intro request: company dialog and candidate side**
```
Company dialog                                     Candidate (Telegram or /intro/[id])
+-----------------------------------------------+  +------------------------------------------+
| Request intro with #3F9A1C                    |  | Acme Labs wants to talk to you about an  |
|                                               |  | Engineer role.                           |
| Message (shown to the candidate)              |  |                                          |
| [We are hiring a Solidity engineer for our   ]|  | "We are hiring a Solidity engineer for   |
| [lending protocol. Open to a 20 minute call? ]|  | our lending protocol. Open to a 20       |
|                                      98 / 600 |  | minute call?"                            |
| Job   [Solidity engineer v]                   |  | Job: Solidity engineer                   |
| Role  [Engineer v]                            |  | Company site: acme.io (domain verified)  |
|                                               |  | This request expires on Oct 12.          |
| The candidate has 14 days to answer. If they  |  |                                          |
| accept, you see their Telegram handle (or     |  | If you accept, Acme Labs will see your   |
| email). Intros left this month: 34 of 40.     |  | Telegram handle @alice. They will not    |
|                                               |  | see your email or wallets.               |
|               [Cancel]  [Send intro request]  |  | [Accept and share my Telegram] [Decline] |
+-----------------------------------------------+  | Decline and block this company           |
                                                   +------------------------------------------+
```

**W6. Developers**
```
+----------------------------------------------------------------------------------------------+
| Developers         [API keys]  [Webhook]  [Usage]  [MCP]                                     |
+----------------------------------------------------------------------------------------------+
| API keys                                                                  [Create key]       |
| Name            Key                  Created by   Last used        Status                    |
| sourcing-bot    ncj_live_8fK2mQ9x..  Dana         2 minutes ago    Active     [Revoke]       |
| old-test        ncj_live_Zq1Lp0aB..  Dana         Sep 20           Revoked                   |
|                                                                                              |
| Webhook                                                                                      |
| URL [https://acme.io/hooks/ncj                 ]  [x] Enabled   [Save] [Send test] [Rotate]  |
| Events: intro.accepted, intro.declined, intro.expired      Last delivery: 200 OK, 10:14      |
|                                                                                              |
| Usage, last 30 days                        Calls    x402 spend                               |
| search_candidates                            412       $0.00                                 |
| get_candidate                                233       $0.00                                 |
| request_intro                                 11       $0.00                                 |
| Pay per request is used only without a subscription. Prices: search $0.50, intro $5.00.      |
+----------------------------------------------------------------------------------------------+
Create key dialog: "Copy this key now. You will not see it again."  [ncj_live_...] [Copy] [Done]
```

---

## 11. Крайові випадки

| Випадок | Поведінка |
|---|---|
| Кандидат вимкнув видимість | Зникає з пошуку одразу (3.4). `get_candidate` → `HiddenCandidate`. Картка: "Candidate is no longer visible"; власні нотатки, теги, історія й уже відкритий контакт лишаються; нових даних немає. Нове знайомство → 409 `candidate_not_visible`. Відкрите знайомство лишається, кандидат може відповісти. Сповіщення збережених пошуків його пропускають. `onVisibilityChanged(userId, false)` пише `visibility_lost` у всі його картки; повернення → `visibility_restored` |
| Прапор 1, але згоду відкликано | Вважається невидимим (правило вимагає обох) |
| Кандидат видалив акаунт | Перед DELETE `beforeCandidateErased(userId)`: для кожної компанії, якій відкрито контакт, рядок `audit_log` `candidate.erased` і лист власникам: "A candidate you were in contact with deleted their account. Please delete any copy of their contact details you keep outside NextCryptoJob." (GDPR ст. 19). Потім каскад: картки, історія, знайомства. `seen_json` чиститься ліниво. Платежі x402 не зачіпає. Вебхук `candidate.erased`: later |
| Кандидат змінив або прибрав Telegram після «так» | Знімок не змінюється ("contact already shared stays, no new data") |
| Direct-режим без Telegram-ніку | Працює як approval |
| Кандидат перемкнув direct → approval після відкриття | Відкрите лишається |
| Відповідь після прострочення або скасування | Сторінка: "This request has expired." / "This request was withdrawn."; кнопки Telegram відповідають тим самим |
| Подвійне натискання «Accept» | Друге оновлення не змінює рядків, відповідь "You already answered this request." |
| Прострочення 14 днів | Розділ 5.5; повторний запит можна за правилом «2 за 90 днів» |
| Закінчилась підписка | Інтерфейс лише для читання; пошук, знайомства, нові вакансії заблоковано (`subscription_required`, для API можна x402); вакансії зникають з добірок; відкриті знайомства живуть, прийняте видно в режимі читання |
| Компанію призупинено | Усі дії й ключі → 403 `company_not_active`; відкриті знайомства скасовано (кандидат побачить "withdrawn"); вакансії сховано |
| Компанію закрито власником | `status = 'closed'`, ключі відкликано, Stripe `subscriptions.cancel`, відкриті знайомства скасовано; видалення даних через 30 днів (у релізі 1 адмін вручну, cron later) |
| Член команди водночас кандидат | Не бачить себе в пошуку своєї компанії |
| Чужа компанія | Картки, знайомства, вакансії, пошуки завжди фільтруються `company_id` актора; чужий id → 404 |
| Відкликаний ключ у польоті | Наступний запит 401 `key_revoked` |
| x402: повтор того самого платежу | 409 `payment_reused` (або попередній результат при тому самому payment-identifier) |
| x402: settle не пройшов | 402 з `PAYMENT-RESPONSE success:false`, без даних, нічого не списано з квот |
| x402: settle пройшов, дія впала | 500 з `details.payment_id`; адмін вирішує про повернення |
| Stripe: події не по порядку | `retrieve` + перезапис рядка |
| Немає ключів Stripe / CDP / вебхука | Розділи 7.3, 7.6, 8: інтерфейс і API кажуть, чого бракує |
| Ворота якості не пройдено | Бали не показуються, пошук з балом порожній з `scores_not_published` |
| Нова версія формули | Бали перераховано; збережені пошуки можуть повідомити про людей, що вперше потрапили в межу, бо вони нові для `seen_json` |
| Ліміти | 429 з `Retry-After`; денні квоти скидаються о 00:00 UTC |

---

## 12. Адмінка (частина CRM; сторінки в міграції 0007 доріжки адмінки)
- "Companies": список (назва, тип, статус, доступ, члени, використання за 30 днів), дії "Suspend", "Reactivate",
  "Grant access" (N днів, причина → `subscriptions` manual), "Revoke all keys".
- "Agency applications": черга, "Approve", "Ask for more info", "Reject" з нотатками.
- "X queue": вакансії `queued`: текст, "Copy", "Mark as posted" (URL), "Skip".
- "Intros": кількість за днями й статусами, недоставлені сповіщення (`notify_error`), "Paid without result".
- "Jobs": "Hide" / "Unhide".
Кожна дія адміна пише `audit_log` з `actor_kind = 'admin'`.

---

## 13. Запити до інших доріжок

| Кому | Що |
|---|---|
| controller | Додати в `contracts.md` §6 і §8: `WEBHOOK_SIGNING_KEY`, `STRIPE_PRICE_ID`, `X402_NETWORK`, `X402_PAY_TO_EVM`, `X402_PAY_TO_SOLANA`, прив'язки `RL_API`, `RL_WEB`, `RL_IP`, cron-тригери. Схвалити два індекси на `scores`/`users` у 0003. Пізніше: поля `chains` і `onchain_years` у `breakdown_json`, щоб фільтр мереж пішов у SQL |
| web: вхід (0002) | Форма `consents` і `audit_log` з розділу 4.3; індекс `consents(user_id, kind)`; виклик `onVisibilityChanged` з перемикача видимості і `beforeCandidateErased` перед видаленням акаунта; блок видалення для останнього власника компанії; сторінка `/me/intros` у кабінеті кандидата |
| web: картки (0005) | Публічна адреса картки не повинна містити `users.id`, інакше компанія зв'яже анонімний профіль з карткою (і ніком на ній) |
| engine (0006) | Читати `company_jobs_live`; не більше 1 вакансії компанії на добірку; правило ролей і місця з 5.6; `sent` має вміщати вакансії компаній (посилання `cj:<job_id>`); збільшувати `company_jobs.digest_shown` |
| legal | Умови для компаній (лише найм, без перепродажу й вивантаження, видалення даних на запит), текст згоди `contact`, рахунки за USDC, гості x402 без акаунта |

---

## 14. Відкриті питання власнику

| № | Питання | Пропозиція |
|---|---|---|
| 1 | Пробний доступ: 14 днів через Stripe з карткою, без картки (`payment_method_collection: "if_required"` + `missing_payment_method: "cancel"`), чи лише ручний від адміна? | З карткою: менше фейкових компаній; для журі й партнерів ручний |
| 2 | Квоти й місця (розділ 9): 300 пошуків/добу, 40 знайомств/місяць, 5 членів | Як у таблиці |
| 3 | Ціни x402: $0.50 пошук, $5 знайомство | Підтвердити |
| 4 | Ціна в євро: €100 чи інша сума в `currency_options`; ціни без ПДВ | €100 без ПДВ |
| 5 | Чи дозволяємо гостям x402 без акаунта шукати (анонімні профілі невідомому платнику)? | Так, лише пошук; спитати юриста |
| 6 | Режим контакту за замовчуванням лишається «після схвалення»? | Так (як у 0001) |
| 7 | Повернення x402, коли платіж пройшов, а знайомство не створилось або кандидата не вдалося сповістити | Ручне повернення адміном протягом 7 днів |
| 8 | Рахунки для USDC-оплат (французьке право вимагає рахунок B2B) | Спитати юриста; до того рахунок PDF вручну |
| 9 | Агенції: обов'язкове поле "Hiring for" у запиті на знайомство | Так |
| 10 | Вакансії компаній: публікувати одразу чи після перевірки адміном | Одразу, адмін може сховати |
| 11 | Фасилітатор-запас PayAI у проді, якщо CDP недоступний | Лише CDP у релізі 1 |

---

## 15. Джерела (перевірено 2026-09-12)
- Cloudflare `createMcpHandler`: https://developers.cloudflare.com/agents/api-reference/mcp-handler-api/ ; `agents@0.23.0` (npm, 2026-09-11)
- x402 v2 специфікація: https://github.com/x402-foundation/x402/blob/main/specs/x402-specification-v2.md
- x402 HTTP-транспорт: https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/http.md
- x402 MCP-транспорт: https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/mcp.md
- x402 exact на EVM і Solana: https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_evm.md , https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_svm.md
- x402 payment-identifier: https://github.com/x402-foundation/x402/blob/main/specs/extensions/payment_identifier.md
- `@x402/core@2.25.0` (методи `x402ResourceServer` звірено з `.d.mts` пакета)
- CDP фасилітатор і мережі: https://docs.cdp.coinbase.com/x402/network-support , https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/x402-facilitator
- PayAI: https://docs.payai.network/x402/facilitators/introduction
- `agents/x402` лише EVM: https://developers.cloudflare.com/agents/x402/ (issue cloudflare/agents#596 закрито як not planned)
- OpenNext власна точка входу: https://opennext.js.org/cloudflare/howtos/custom-worker ; Stripe на OpenNext: https://opennext.js.org/cloudflare/howtos/stripeAPI
- Workers Rate Limiting: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
- Stripe Checkout: https://docs.stripe.com/api/checkout/sessions/create ; пробний: https://docs.stripe.com/payments/checkout/free-trials
- Stripe Tax у Checkout і VAT ID: https://docs.stripe.com/tax/checkout/page , https://docs.stripe.com/tax/checkout/tax-ids , https://docs.stripe.com/tax/zero-tax
- Stripe Customer Portal: https://docs.stripe.com/customer-management/integrate-customer-portal
- Stripe вебхуки підписок: https://docs.stripe.com/billing/subscriptions/webhooks , https://docs.stripe.com/webhooks
- Stripe basil, періоди на елементах підписки: https://docs.stripe.com/changelog/basil/2025-03-31/deprecate-subscription-current-period-start-and-end
- Stripe кілька валют у ціні: https://docs.stripe.com/products-prices/manage-prices ; stablecoin-підписки (preview): https://docs.stripe.com/billing/subscriptions/stablecoins

---

## 16. Implementation tasks

Порядок: T1 → T2 → (T3, T6, T8 паралельно) → T4 → T5 → (T7, T9) → T10 → T11 → T12.
Оцінка: 3 людини × 5 днів. Тести поведінки, не констант.

| № | Задача | Файли | Готово, коли |
|---|---|---|---|
| T1 | Міграції й основа доступу до даних | `db/migrations/0003_crm.sql`, `0004_billing.sql`, `web/src/lib/db.ts`, `web/src/lib/ids.ts`, `web/src/lib/time.ts` | 0003 і 0004 накочені на локальну і прод D1 після 0002; `schema_migrations` має обидва рядки; тест: id мають префікс і 20 символів base62 |
| T2 | Актор, права, квоти, журнал | `web/src/lib/crm/{context,permissions,quotas,audit,actions,types}.ts`, `web/wrangler.jsonc` (RL_*) | тести: ключ з хешем знаходить компанію, відкликаний дає 401; member не створює ключ; 301-й пошук за добу дає 429 з `RateLimit-*`; кожна дія над кандидатом пише `audit_log` |
| T3 | Проєкція профілю й пошук | `web/src/lib/crm/{visibility,project,search}.ts` + тести | тести: невидимий, без згоди, заблокований і член команди не з'являються; у відповіді немає адрес, ніків, пошти (перевірка регулярками); `min_level` і сортування ставлять непораховані в кінець; порожній результат має `empty_reason`; 11-та сторінка дає `page_cap_reached` |
| T4 | Воронка, нотатки, теги, історія, хуки видимості | `web/src/lib/crm/pipeline.ts`, `visibility.ts` (`onVisibilityChanged`, `beforeCandidateErased`) | тести переходів з 5.4 (заборонені дають правильні коди); вимкнення видимості дає `visibility_lost` у всіх картках і `HiddenCandidate` з нотатками й контактом |
| T5 | Знайомства | `web/src/lib/crm/{intros,notify}.ts`, `web/src/app/intro/[id]/page.tsx`, обробник callback у вебхуку бота, `web/src/lib/cron/index.ts` (`expireIntros`) | живий прогін: компанія просить → власник отримує Telegram → «Accept» → картка `contact_shared` з ніком; «Decline and block» ховає кандидата від компанії; прострочення повертає в `found`; подвійне «Accept» не ламає стан |
| T6 | Онбординг компанії, команда, агенції, налаштування | `web/src/app/company/{page,start,join,team,settings}/…`, `web/src/app/admin/agency-applications/…` | тестова компанія з двома людьми; агенція бачить "Application received", після "Approve" отримує доступ; домен з gmail не позначається перевіреним |
| T7 | Екрани CRM | `web/src/app/company/{dashboard,search,candidates/[id],pipeline,saved-searches,jobs}/…`, `web/src/components/crm/*` | W1–W5 працюють на телефоні (≥ 360 px) і десктопі; усі порожні стани й помилки з розділу 10 показано; перевірено живим прогоном |
| T8 | Оплата: Stripe, ручний доступ, доступ | `web/src/lib/billing/{stripe,access}.ts`, `web/src/app/api/stripe/webhook/route.ts`, `web/src/app/company/billing/…`, `web/src/app/admin/companies/…` | тестова підписка в режимі test проходить Checkout з trial; події в будь-якому порядку дають правильний рядок; скасування в порталі знімає доступ після кінця періоду; без `STRIPE_SECRET_KEY` видно "Card payments are coming soon" |
| T9 | x402 і REST API | `web/src/lib/x402/{server,http}.ts`, `web/src/app/api/v1/**/route.ts`, `web/src/lib/billing/usdc.ts` | усі 28 операцій відповідають схемам `openapi.yaml` (тест валідацією відповідей); гість платить $0.50 на Base Sepolia і Solana devnet і отримує сторінку; повтор того самого платежу дає 409; невдалий settle не віддає даних |
| T10 | MCP-сервер | `web/src/app/mcp/route.ts`, `web/src/lib/x402/mcp.ts`, `web/src/lib/crm/actions.test.ts` | Claude Desktop з ключем бачить 28 інструментів, без ключа 2; платний `search_candidates` через `_meta["x402/payment"]` на тестовій мережі; тест паритету з `mcp-tools.md` розділ 5 зелений |
| T11 | Вебхук і cron | `web/src/lib/crm/webhooks.ts`, `web/worker.ts`, `web/src/lib/cron/index.ts`, `web/src/app/company/developers/…` | тестовий приймач перевіряє підпис; невдалий приймач отримує 6 спроб за розкладом і плашку "Your webhook is failing"; ротація шле два підписи 24 год; cron-тригери видно в `wrangler deployments` |
| T12 | Вакансії компаній, публічна сторінка, черга X, `search_jobs` | `web/src/lib/crm/jobs.ts`, `web/src/app/jobs/[id]/…`, `web/src/app/admin/x-queue/…`, `web/src/app/api/v1/public/jobs/route.ts` | вакансія тестової компанії з підпискою є в `company_jobs_live` і в `search_jobs`, після закриття зникає; перехід "Apply" збільшує `apply_clicks`; адмін позначає пост як опублікований |

Критерій усього етапу (з плану 3.7): тестовий агент через MCP знаходить власника (лише після ввімкнення
видимості), просить знайомство і отримує Telegram-нік після «так».
Later: перетягування карток, редагування нотаток, нагадування на 7-й день, вебхук `candidate.erased`,
оплата USDC гаманцем у браузері, перевірка домену через DNS, псевдоніми кандидатів окремо для кожної компанії,
тестові ключі `ncj_test_` з вигаданими кандидатами, OAuth для MCP, сторінка «хто переглядав мій профіль» для кандидата.
