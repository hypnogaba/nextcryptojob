# NextCryptoJob MCP tools

Дата: 2026-09-12. Договір для реалізації. Кожен інструмент відповідає рівно одній операції REST з
`docs/api/openapi.yaml` (поле `x-mcp-tool` там). Вхід = параметри шляху + параметри запиту + тіло REST,
злиті в один об'єкт. Вихід (`structuredContent`) = тіло успішної відповіді REST, байт у байт.
Одна реєстрація дій у коді (`web/src/lib/crm/actions.ts`, специфікація розділ 6.2) породжує і маршрути REST,
і інструменти MCP, тож розійтися вони не можуть.

## 1. Підключення

| Що | Значення |
|---|---|
| Адреса | `POST https://nextcryptojob.xyz/mcp` (streamable HTTP, без стану) |
| Сервер | `createMcpHandler(factory, { route: "/mcp", allowedHostnames, allowedOriginHostnames })` з `agents/mcp/server` (`agents@0.23.0`, MCP SDK `@modelcontextprotocol/server@2.0.0`); factory будує новий `McpServer` на кожен запит |
| Next.js | `web/src/app/mcp/route.ts` викликає `handler.fetch(req)`; GET, POST, DELETE, OPTIONS ведуть в один обробник |
| Ключ | заголовок HTTP `Authorization: Bearer ncj_live_…`; factory читає його з `requestInfo` і будує набір інструментів під актора |
| Без ключа | `tools/list` показує лише `search_jobs` (безкоштовно) і `search_candidates` (x402) |
| З ключем | усі 28 інструментів; ті, що вимагають підписки, повертають помилку `subscription_required`, а не зникають |
| Документація | https://developers.cloudflare.com/agents/api-reference/mcp-handler-api/ |

Приклад налаштування клієнта (Claude Desktop, Cursor та інші з підтримкою remote MCP):
```json
{ "mcpServers": { "nextcryptojob": {
    "url": "https://nextcryptojob.xyz/mcp",
    "headers": { "Authorization": "Bearer ncj_live_..." } } } }
```

## 2. Оплата x402 у MCP

Транспорт за специфікацією x402 v2 для MCP:
https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/mcp.md

1. Клієнт викликає платний інструмент без оплати. Сервер відповідає результатом інструмента:
   ```json
   { "isError": true,
     "structuredContent": { "x402Version": 2, "error": "Payment required",
       "resource": { "url": "mcp://tool/search_candidates", "description": "NextCryptoJob candidate search, one page of up to 20 results", "mimeType": "application/json" },
       "accepts": [ { "scheme": "exact", "network": "eip155:8453", "amount": "500000", "asset": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "payTo": "0x…", "maxTimeoutSeconds": 60, "extra": { "name": "USD Coin", "version": "2" } },
                    { "scheme": "exact", "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", "amount": "500000", "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "payTo": "…", "maxTimeoutSeconds": 60, "extra": { "feePayer": "…" } } ] },
     "content": [ { "type": "text", "text": "<той самий JSON>" } ] }
   ```
2. Клієнт повторює `tools/call` з `params._meta["x402/payment"]` = об'єкт PaymentPayload (не base64).
3. Сервер перевіряє, виконує, розраховується і додає `_meta["x402/payment-response"]` = SettlementResponse
   до результату. Невдалий розрахунок дає той самий вигляд, що в кроці 1, без даних інструмента.

Реалізація: власна тонка обгортка `web/src/lib/x402/mcp.ts` поверх `x402ResourceServer` з `@x402/core/server`
(`buildPaymentRequirements`, `createPaymentRequiredResponse`, `verifyPayment`, `settlePayment`), яка читає
`ctx.mcpReq._meta` (SDK v2). Готовий `createPaymentWrapper` з `@x402/mcp@2.25.0` читає `extra._meta` (SDK v1)
і під SDK v2 завжди казав би «потрібна оплата»; `withX402` з `agents/x402` лише для EVM. Тому обидва не беремо.

Ціни (однакові з REST):

| Інструмент | Ключ + підписка | Ключ без підписки | Без ключа |
|---|---|---|---|
| `search_candidates` | входить у квоту | $0.50 | $0.50 |
| `request_intro` | входить у квоту | $5.00 | недоступно (`key_required`) |
| `buy_usdc_month` | $100.00 | $100.00 | недоступно |
| `search_jobs` | безкоштовно | безкоштовно | безкоштовно |
| решта | безкоштовно | безкоштовно | недоступно |

## 3. Загальні правила

- Вихід: `structuredContent` = тіло REST; `content` = `[{"type":"text","text": JSON}]` для старих клієнтів.
  Кожен інструмент оголошує `outputSchema` (посилання нижче ведуть у `openapi.yaml#/components/schemas/…`).
- Помилка дії: `isError: true`, `structuredContent = { "error": { "code", "message", "request_id", "details"? } }`,
  коди ті самі, що в REST (`openapi.yaml#/components/schemas/Error`). Невалідний вхід: така сама помилка
  `validation_failed` з `details.fields`, як REST 422 (MCP SDK v2 віддає помилку аргументів лише результатом
  з `isError`, не помилкою протоколу). Невідомий інструмент: помилка протоколу `-32602`.
  Інструмент, дію якого ще не запущено, відповідає `not_implemented` (REST 501) раніше за будь-яку вимогу оплати.
  Код `forbidden` (роль команди не має права) буває лише в інтерфейсі: ключ діє від імені компанії.
- Квоти й ліміти ті самі, що в REST (специфікація, розділ 9). Замість заголовків `RateLimit-*` результат
  має `_meta["ncj/quota"] = { "limit", "remaining", "reset_seconds" }`.
- Кожна дія над кандидатом пишеться в `audit_log` з `channel = 'mcp'`.
- Анотації: `readOnlyHint` для читання; `destructiveHint` для `remove_from_pipeline`, `delete_saved_search`,
  `cancel_intro`, `close_job`; `idempotentHint` для `add_to_pipeline`, `set_webhook`; `openWorldHint: true`
  для `request_intro` (пише людині).

## 4. Інструменти

Спільні фрагменти схем (JSON Schema 2020-12):
```json
{ "$defs": {
  "candidate_id": { "type": "string", "format": "uuid" },
  "role": { "type": "string", "enum": ["engineer","security_auditor","devrel","data_research","product_manager","bd",
    "marketing_content","creator_kol","community","trader","designer","operations_support","finance","legal_compliance","hr_recruiting"] },
  "chain": { "type": "string", "enum": ["ethereum","base","arbitrum","optimism","solana","hyperliquid"] },
  "stage": { "type": "string", "enum": ["found","intro_requested","contact_shared","interview","hired","declined"] },
  "tags": { "type": "array", "maxItems": 10, "items": { "type": "string", "minLength": 1, "maxLength": 32 } },
  "job_id": { "type": "string", "pattern": "^job_[A-Za-z0-9]{20}$" },
  "cursor": { "type": "string", "maxLength": 512 },
  "filters": { "type": "object", "additionalProperties": false, "properties": {
    "role": { "$ref": "#/$defs/role" },
    "min_score": { "type": "integer", "minimum": 0, "maximum": 100 },
    "min_level": { "type": "integer", "minimum": 1, "maximum": 10 },
    "max_level": { "type": "integer", "minimum": 1, "maximum": 10 },
    "chains": { "type": "array", "maxItems": 6, "uniqueItems": true, "items": { "$ref": "#/$defs/chain" } },
    "min_onchain_years": { "type": "integer", "enum": [1, 2, 4, 6] },
    "work_mode": { "type": "string", "enum": ["remote", "city"] },
    "city": { "type": "string", "maxLength": 80 },
    "x_verified": { "type": "boolean" },
    "wallet_verified": { "type": "boolean" },
    "min_coverage": { "type": "integer", "minimum": 0, "maximum": 100 },
    "contact_direct": { "type": "boolean" },
    "exclude_in_pipeline": { "type": "boolean" } } },
  "job_fields": { "type": "object", "properties": {
    "title": { "type": "string", "minLength": 3, "maxLength": 120 },
    "description": { "type": "string", "maxLength": 5000 },
    "roles": { "type": "array", "minItems": 1, "maxItems": 3, "uniqueItems": true, "items": { "$ref": "#/$defs/role" } },
    "work_mode": { "type": "array", "minItems": 1, "uniqueItems": true, "items": { "type": "string", "enum": ["remote","city"] } },
    "city": { "type": ["string","null"], "maxLength": 80 },
    "country": { "type": ["string","null"], "pattern": "^[A-Z]{2}$" },
    "salary": { "oneOf": [ { "type": "null" }, { "type": "object", "required": ["currency","period"], "properties": {
      "min": { "type": ["integer","null"], "minimum": 0 }, "max": { "type": ["integer","null"], "minimum": 0 },
      "currency": { "type": "string", "pattern": "^[A-Z]{3}$" }, "period": { "type": "string", "enum": ["year","month"] } } } ] },
    "apply_url": { "type": ["string","null"], "format": "uri" },
    "tags": { "$ref": "#/$defs/tags" },
    "post_on_x": { "type": "boolean" } } }
} }
```

### 4.1 Рахунок

| Інструмент | REST | Ціна | Вхід | Вихід |
|---|---|---|---|---|
| `get_account` | `GET /me` | free, key | `{}` | `Account` |
| `get_usage` | `GET /usage` | free, key | `{"from"?: "YYYY-MM-DD", "to"?: "YYYY-MM-DD"}` | `Usage` |

`get_account` опис для моделі: "Returns your company, access mode (subscription or pay per request), quotas left today and x402 prices. Call this first."

### 4.2 Кандидати

**`search_candidates`** → `POST /candidates/search`. Ціна: $0.50 за сторінку для гостей і компаній без підписки.
Опис: "Search anonymous profiles of candidates who chose to be visible to companies. Returns up to 20 per page, max 10 pages per query. No names, handles, wallets or emails."
```json
{ "type": "object", "additionalProperties": false, "properties": {
  "filters": { "$ref": "#/$defs/filters" },
  "sort": { "type": "string", "enum": ["score","level","coverage","newest"], "default": "score" },
  "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 },
  "cursor": { "$ref": "#/$defs/cursor" } } }
```
Вихід: `SearchResponse` (`data[]` з `CandidateSummary`, `next_cursor`, `page`, `page_cap_reached`, `empty_reason`, `role_visible_count`).

**`get_candidate`** → `GET /candidates/{candidate_id}`. Free, key; денна квота переглядів.
Опис: "Full anonymous profile with the score breakdown per chosen role. Contact appears only after an accepted intro or in direct mode."
```json
{ "type": "object", "additionalProperties": false, "required": ["candidate_id"],
  "properties": { "candidate_id": { "$ref": "#/$defs/candidate_id" } } }
```
Вихід: `CandidateProfile` або `HiddenCandidate` (розрізняє поле `visibility`).

### 4.3 Воронка

| Інструмент | REST | Вхід | Вихід |
|---|---|---|---|
| `list_pipeline` | `GET /pipeline` | `{"stage"?: stage, "tag"?: string≤32, "job_id"?: job_id, "cursor"?: cursor, "limit"?: 1..50}` | `PipelineList` |
| `add_to_pipeline` | `PUT /pipeline/{candidate_id}` | `{"candidate_id": uuid, "role"?: role, "job_id"?: job_id, "tags"?: tags}` | `PipelineCard` |
| `update_stage` | `PATCH /pipeline/{candidate_id}` | `{"candidate_id": uuid, "stage"?: "found"\|"interview"\|"hired"\|"declined", "tags"?: tags, "job_id"?: job_id\|null}`, хоч одне поле крім id | `PipelineCard` |
| `remove_from_pipeline` | `DELETE /pipeline/{candidate_id}` | `{"candidate_id": uuid}` | `{}` (REST 204) |
| `list_candidate_history` | `GET /pipeline/{candidate_id}/events` | `{"candidate_id": uuid, "cursor"?: cursor, "limit"?: 1..50}` | `PipelineEventList` |
| `add_note` | `POST /pipeline/{candidate_id}/notes` | `{"candidate_id": uuid, "body": string 1..2000}` | `PipelineEvent` |

Усі безкоштовні з ключем. `update_stage` не приймає `intro_requested` і `contact_shared`: ці етапи ставить лише
процес знайомства. `interview` і `hired` потребують відкритого контакту (`contact_not_shared` інакше).

### 4.4 Знайомства

**`request_intro`** → `POST /intros`. $5.00 через x402 для компаній без підписки; для решти в межах квоти.
Опис: "Ask the candidate for an intro. They get your company name, your message and the linked job, and have 14 days to accept. If they accept, you get their Telegram handle (or email). In direct mode the contact comes back at once."
```json
{ "type": "object", "additionalProperties": false, "required": ["candidate_id","message"], "properties": {
  "candidate_id": { "$ref": "#/$defs/candidate_id" },
  "message": { "type": "string", "minLength": 20, "maxLength": 600 },
  "role": { "$ref": "#/$defs/role" },
  "job_id": { "$ref": "#/$defs/job_id" },
  "hiring_for": { "type": "string", "minLength": 2, "maxLength": 80, "description": "Required for agencies: the client, or \"Confidential client\"." } } }
```
Вихід: `Intro`. Порядок для x402: verify → settle → створити знайомство → сповістити кандидата
(ефект незворотний, тому розрахунок до нього).

| Інструмент | REST | Вхід | Вихід |
|---|---|---|---|
| `intro_status` | `GET /intros/{intro_id}` | `{"intro_id": "int_…"}` | `Intro` |
| `list_intros` | `GET /intros` | `{"status"?: "pending"\|"accepted"\|"declined"\|"expired"\|"canceled"\|"direct", "updated_since"?: date-time, "cursor"?: cursor, "limit"?: 1..50}` | `IntroList` |
| `cancel_intro` | `POST /intros/{intro_id}/cancel` | `{"intro_id": "int_…"}` | `Intro` |

Агент без вебхука опитує `list_intros` з `updated_since` (не частіше 1 разу на хвилину).

### 4.5 Вакансії

| Інструмент | REST | Вхід | Вихід |
|---|---|---|---|
| `list_jobs` | `GET /jobs` | `{"status"?: "draft"\|"open"\|"closed", "cursor"?: cursor, "limit"?: 1..50}` | `JobList` |
| `post_job` | `POST /jobs` | `job_fields` + `required: ["title","roles","work_mode"]` + `"status"?: "draft"\|"open"` | `Job` |
| `get_job` | `GET /jobs/{job_id}` | `{"job_id": job_id}` | `Job` |
| `update_job` | `PATCH /jobs/{job_id}` | `{"job_id": job_id}` + будь-які поля `job_fields` + `"status"?: "draft"\|"open"` | `Job` |
| `close_job` | `POST /jobs/{job_id}/close` | `{"job_id": job_id}` | `Job` |

`post_job` і `update_job` потребують підписки (`subscription_required`). Відкрита вакансія потребує `apply_url`.

### 4.6 Збережені пошуки

| Інструмент | REST | Вхід | Вихід |
|---|---|---|---|
| `list_saved_searches` | `GET /saved-searches` | `{}` | `{"data": SavedSearch[]}` |
| `create_saved_search` | `POST /saved-searches` | `{"name": string 1..80, "filters": filters, "sort"?: …, "alert"?: "off"\|"daily"}` | `SavedSearch` |
| `update_saved_search` | `PATCH /saved-searches/{id}` | `{"saved_search_id": "ss_…", "name"?, "filters"?, "sort"?, "alert"?}` | `SavedSearch` |
| `delete_saved_search` | `DELETE /saved-searches/{id}` | `{"saved_search_id": "ss_…"}` | `{}` |

### 4.7 Вебхук

| Інструмент | REST | Вхід | Вихід |
|---|---|---|---|
| `get_webhook` | `GET /webhook` | `{}` | `Webhook` (`secret` = null) |
| `set_webhook` | `PUT /webhook` | `{"url"?: https-uri ≤500, "enabled"?: bool, "rotate_secret"?: bool}`, хоч одне поле | `Webhook` (з `secret` при першому URL або ротації) |
| `test_webhook` | `POST /webhook/test` | `{}` | `{"delivered": bool, "status_code": int\|null, "error": string\|null, "duration_ms": int}` |

Підпис вебхука: `NCJ-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, t + "." + body)>` (специфікація, розділ 7.6).

### 4.8 Оплата

**`buy_usdc_month`** → `POST /billing/usdc-month`. $100.00 через x402, лише з ключем.
Опис: "Pay 100 USDC on Base or Solana for 30 days of subscription access."
Вхід `{}`. Вихід `UsdcMonthResult`.

### 4.9 Для кандидатів (публічно)

**`search_jobs`** → `GET /public/jobs`. Безкоштовно, без ключа, 30 запитів на хвилину з IP.
Опис: "Search open crypto jobs (company jobs and the NextRole crawl). Jobs only, never people."
```json
{ "type": "object", "additionalProperties": false, "properties": {
  "q": { "type": "string", "maxLength": 100 },
  "role": { "$ref": "#/$defs/role" },
  "work_mode": { "type": "string", "enum": ["remote","city"] },
  "city": { "type": "string", "maxLength": 80 },
  "salary_min": { "type": "integer", "minimum": 0 },
  "currency": { "type": "string", "pattern": "^[A-Z]{3}$" },
  "cursor": { "$ref": "#/$defs/cursor" },
  "limit": { "type": "integer", "minimum": 1, "maximum": 20, "default": 20 } } }
```
Вихід: `PublicJobList`.

## 5. Перевірка паритету (тест)

`web/src/lib/crm/actions.test.ts` проходить реєстр дій і перевіряє:
1. кожна дія має `rest` (метод + шлях) і `mcp` (назва) і збігається з `x-mcp-tool` в `openapi.yaml` і з таблицями розділу 4;
2. `z.toJSONSchema(input)` дорівнює злитим параметрам і тілу операції REST за смислом: типи, переліки, межі
   (min/max, довжини, кількість елементів), формати, шаблони, обов'язковість, вкладені об'єкти, закритість;
3. `z.toJSONSchema(output)` так само дорівнює схемі успішної відповіді REST;
4. JSON-схеми розділу 4 (`$defs`, `search_candidates`, `get_candidate`, `request_intro`, `search_jobs`) дорівнюють входу з реєстру;
5. ціна в реєстрі дорівнює `x-x402-price-usd`; анотації дорівнюють розділу 3.
Не порівнюються лише `uniqueItems` і `minProperties`: у zod це перевірки коду (refine), їх ловлять поведінкові тести.
