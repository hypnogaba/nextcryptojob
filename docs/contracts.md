# NextCryptoJob: спільний договір web ↔ engine

Власник документа: controller. Зміни лише через controller, бо від нього залежать обидві доріжки.
Схема ядра: `db/migrations/0001_core.sql`. Інтерфейс продукту англійською; усі тексти для
людей без довгого тире (U+2014).

## 1. Ролі (ключ → назва в інтерфейсі)
| Ключ | Назва (EN) | Рахується в релізі 1 |
|---|---|---|
| engineer | Engineer | так |
| security_auditor | Security auditor | так |
| devrel | DevRel | так |
| data_research | Data & research | так |
| product_manager | Product / project manager | так |
| bd | BD & partnerships | так |
| marketing_content | Marketing & content | так |
| creator_kol | Creator / KOL | так |
| community | Community | так |
| trader | Trader | так |
| designer | Designer | ні: `needs_portfolio` |
| operations_support | Operations & support | ні: `needs_cv` |
| finance | Finance | ні: `needs_cv` |
| legal_compliance | Legal & compliance | ні: `needs_cv` |
| hr_recruiting | HR & recruiting | ні: `needs_cv` |

## 2. Ідентичності (`identities.kind`, нормалізація `value`)
- `x`: нік без `@`, нижній регістр.
- `github`: логін, нижній регістр.
- `youtube`: `@handle` нижній регістр або channel id `UC…` як є.
- `site`: `https://` + хост + шлях без кінцевого `/`, хост нижній регістр.
- `evm`: адреса `0x` + 40 hex, нижній регістр (перевірка формату, без checksum-вимоги).
- `solana`: base58, 32–44 символи, як є.
- `sherlock` (v5): нік Sherlock, нижній регістр; приймається, лише якщо `github_handle` або `twitter_handle` у профілі Sherlock збігається з GitHub або X людини (`verified_via = 'profile_link'`).
Визначення типу гаманця з вставленого тексту: `0x[0-9a-fA-F]{40}` → evm; base58 32–44 → solana;
ENS `*.eth` / SNS `*.sol` у релізі 1 не розвʼязуємо (поле просить адресу).

## 3. Факти джерел (`source_facts.facts_json`)
Правило: поле, якого джерело не віддало, дорівнює `null`, а не 0. Якщо джерело не відповіло
зовсім, `facts_json = NULL`, `gap_reason = '<людська причина>'`.

```ts
type XFacts = { followers: number|null; kol: number|null; kolSourceGap: boolean;
  fetched: number; own: number; repliesMade: number; own30d: number;
  ownAvgLikesRt: number|null; ownAvgViews: number|null; ownAvgReplies: number|null;
  daysCovered: number|null };
// own = власні пости: conversationId == id і текст не починається з "RT @"

type GithubFacts = { createdAt: string; followers: number; stars: number;   // зірки власних не-форків
  commits12m: number; reviews12m: number; mergedPrsElsewhere: number;       // злиті PR у репо чужих власників
  reposPushed12m: number; reposWithSite: number };

type EvmChainFacts = { sent: number|null; sentCapped: boolean; firstTs: number|null;
  swaps: number|null; source: 'etherscan'|'blockscout'; gap?: string };
type EvmFacts = { [address: string]: { ethereum?: EvmChainFacts; base?: EvmChainFacts;
  arbitrum?: EvmChainFacts; optimism?: EvmChainFacts } };

type HyperliquidFacts = { [address: string]: { volumeUsd: number|null; fillsRecent: number|null } };

type SolanaFacts = { [address: string]: { sigs: number; sigsOk: number; sigsCapped: boolean;
  firstTs: number|null; sampleSeen: number; sampleSwaps: number; swaps: number|null } };
// swaps = null, якщо sampleSeen < 50 (замала вибірка = прогалина); ВИНЯТОК: якщо перевірено всі успішні
// транзакції (sampleSeen = sigsOk) і список не обрізаний (sigsCapped = false), кількість точна → swaps = sampleSwaps

type YoutubeFacts = { channelId: string; subscribers: number|null; hiddenSubscribers: boolean;
  avgViewsRecent: number|null; videos90d: number|null };

type SiteFacts = { reachable: boolean; feedItems: number; items90d: number; sitemapUrls: number;
  latestTs: number|null };

// v5
type AuditsFacts = { earningsUsd: number|null; high: number|null; contests: number|null;
  providers: { [p: string]: { earningsUsd: number; high: number; medium: number; contests: number } };
  verifiedBy: 'github'|'x'; gap?: string };   // 0 конкурсів або немає перевіреного профілю → gap, earningsUsd = null
type DuneFacts = { spellbookPrs: number|null; spellbookPrs12m: number|null };  // злиті PR у duneanalytics/spellbook (за GitHub людини)
```

## 4. Формула v5 (`formula_version = "v5"`; v4 + зміни в кінці розділу)
`logn(x, cap) = min(1, log10(1+max(0,x)) / log10(1+cap))`, `lin(x, cap) = min(1, max(0,x)/cap)`;
`null` на вході дає `null`. `combine([(w, v)…]) = 100 · Σ w·v / Σ w` лише по не-`null` v;
якщо всі `null` → `null`.

Бали джерел (0–100):
- `gh_eng` = combine(35·logn(mergedPrsElsewhere,1000), 25·logn(stars,5000), 15·logn(reviews12m,300),
  15·logn(followers,3000), 10·logn(commits12m,2000))
- `gh_builder` = combine(40·lin(reposPushed12m,12), 30·lin(reposWithSite,4), 30·logn(commits12m,1500))
- `x` = combine(15·logn(followers,500000), 30·(kolSourceGap ? null : logn(kol,1000)),
  15·logn(ownAvgLikesRt,1500), 15·logn(ownAvgViews,150000), 15·logn(ownAvgReplies,150),
  10·lin(own / daysCovered · 30, 20) (daysCovered null або 0 → null)); якщо followers = null → `x = null`
- `yt` = combine(45·logn(subscribers,1000000), 35·logn(avgViewsRecent,100000), 20·lin(videos90d,12));
  якщо subscribers = null → `yt = null`
- Гаманці зводяться в: `ageYears` (найраніший firstTs серед EVM і Solana без sigsCapped),
  `tx` (Σ EVM sent + Σ Solana sigs), `chains` (мережі з активністю, Hyperliquid рахується),
  `trades` (Σ EVM swaps + Σ Solana swaps + Σ HL fillsRecent), `tradeChains`, `hlVolume`,
  `tradeGap` (хоч одна Solana з swaps = null).
- `onchain` = combine(35·lin(ageYears,6), 35·logn(tx,10000), 30·lin(|chains|,6)); без гаманців → null
- `trading` = без гаманців → null; trades = 0 → (tradeGap ? null : 0);
  інакше combine(45·logn(trades,3000), 20·lin(|tradeChains|,4), 20·logn(hlVolume,5000000), 15·logn(held,20))
  (`held` у релізі 1 = null)
- `site` = недоступний → null; інакше 30 + 0.7·(combine(40·logn(feedItems,100), 20·lin(items90d,8),
  10·logn(sitemapUrls,150)) ?? 0)
- `media` = max(x, yt) з не-null; `output` = max(site, gh_eng) з не-null.

Ролі: ядро (ваги), додатки (макс. балів), головні джерела (потрібне хоч одне не-null і не 0):
| Роль | Ядро | Додатки | Головні |
|---|---|---|---|
| engineer | gh_eng 80, x 20 | onchain 5, site 5 | gh_eng |
| security_auditor | gh_eng 70, x 30 | site 5, onchain 5 | gh_eng |
| devrel | media 50, gh_eng 50 | site 5, onchain 5 | media, gh_eng |
| data_research | output 50, x 50 | onchain 5, gh_builder 5 | output |
| product_manager | x 50, gh_builder 25, site 25 | onchain 5, gh_eng 5 | x |
| bd | x 100 | onchain 5, site 5 | x |
| marketing_content | media 100 | site 7, onchain 3 | media |
| creator_kol | media 100 | onchain 5, site 5 | media |
| community | x 100 | onchain 7, site 3 | x |
| trader | trading 80, onchain 20 | x 5, site 5 | trading |

`core = Σ w·(s ?? 0) / Σ w`; `bonus = Σ max·(s ?? 0)/100`; `score = min(100, core + bonus)`;
`cover = Σ w` по ядру з не-null джерелами. Без головного джерела → `score = null`,
`reason = 'missing_anchor:<ключі>'`. Рівень картки: `level = min(10, floor(score/10) + 1)`.

Зміни v5 (дослідження 12.09: 85% в межах сусіднього рівня на еталоні з 49 людей):
- `audits` = earningsUsd = null або gap → null; інакше combine(60·logn(earningsUsd/1000, 1000), 40·logn(high, 150)).
- `dune` = spellbookPrs = null або 0 → null; інакше combine(70·logn(spellbookPrs, 300), 30·logn(spellbookPrs12m, 50)).
- `output` = max(site, gh_eng, dune) з не-null.
- security_auditor: ядро = більше з двох шляхів: (audits 60, gh_eng 25, x 15) або (gh_eng 70, x 30);
  додатки site 5, onchain 5; головні: audits, gh_eng. `breakdown_json.reason = 'path:audits'` або `'path:gh_eng+x'`.
- data_research: головні output, x; якщо output = null → core = 0.8·x і `reason = 'x_only'`; інакше як у v4.
- Джерела фактів додаються: `audits` (Sherlock watson JSON: /watson/<h>, /stats/stats/<h>, /stats/resume/<h>),
  `dune` (GitHub search: злиті PR автора в duneanalytics/spellbook, усього й за 12 міс.).
  Code4rena, Immunefi, профілі Dune не збираємо: їхні умови забороняють автоматичний збір.

`breakdown_json`:
```json
{ "formula": "v5", "sources": {"x": 46.3, "gh_eng": 28.9, "...": null},
  "core": {"x": {"weight": 50, "value": 46.3}}, "bonus": {"onchain": {"max": 5, "value": 91.7}},
  "cover": 100, "level": 7, "reason": null, "gaps": {"solana": "sample too small"} }
```

## 5. Черга score_jobs
- web додає рядок `status='queued'` після зміни ідентичностей або ролей (не частіше 1 разу на 60 с на людину).
- engine забирає: `UPDATE score_jobs SET status='running', started_at=datetime('now'), attempts=attempts+1
  WHERE id=? AND status='queued'` (перевірка changes = 1), збирає, пише `source_facts` і `scores`,
  ставить `done` або `failed` з `error`. Невдале повторюється до 3 спроб.
- Щотижневе оновлення: engine сам ставить `refresh` для людей, чий найстаріший `fetched_at` > 7 днів,
  рівномірно по годинах.

## 6. Змінні оточення (лише назви)
- engine (`/etc/nextcryptojob-engine.env` на VPS): `CF_ACCOUNT_ID`, `CF_D1_DATABASE_ID`, `CF_API_TOKEN`,
  `TWITTER_TOKEN` (6551), `ETHERSCAN_KEY`, `BLOCKSCOUT_KEY`, `HELIUS_KEY`, `YOUTUBE_KEY`, `GITHUB_TOKEN`;
  необов'язкові: `ENGINE_CONCURRENCY` (3), `ENGINE_DEADLINE_MS` (45000), `ENGINE_SHUTDOWN_GRACE_MS` (60000),
  `SELECTOR_CACHE` (/var/lib/nextcryptojob-engine/selectors.json).
- web (secrets Worker): `TWITTER_TOKEN`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
  `TELEGRAM_OIDC_CLIENT_ID`, `TELEGRAM_OIDC_CLIENT_SECRET`, `SESSION_SECRET`; binding `DB` = D1 `nextcryptojob`
  (`c66a99cf-230b-4b8b-9cff-862d4b18a4ae`), `JOBS_DB` = D1 `crypto-jobs-agent` (лише читання в коді).

## 7. Номери міграцій (щоб доріжки не зіткнулись)
| Файл | Власник | Таблиці |
|---|---|---|
| 0001_core.sql | controller | users, identities, source_facts, scores, score_jobs, quality_runs |
| 0002_auth.sql | web: вхід | sessions, login_codes, auth_attempts, consents, consent_events, webhook_updates, audit_log |
| 0003_crm.sql | web: CRM | companies, company_members, saved_searches, pipeline, pipeline_events, intros, company_jobs, agency_applications |
| 0004_billing.sql | web: оплата й агенти | subscriptions, api_keys, x402_payments, usage_events |
| 0005_cards.sql | web: картки | cards |
| 0006_digest.sql | engine: добірка | sent, digest_runs |
| 0007_admin.sql | web: адмінка | appeals, admin_flags |
| 0008_sources_v5.sql | controller | перебудова identities і source_facts (sherlock, audits, dune) |
Нова таблиця поза цим списком лише через controller.

## 8. Ключі, яких ще немає (власник додасть у кінці)
Код мусить працювати без них у тестовому режимі і явно казати, чого бракує:
`HELIUS_KEY`, `BLOCKSCOUT_KEY`, `YOUTUBE_KEY`, `GITHUB_TOKEN`, `TELEGRAM_OIDC_CLIENT_ID`,
`TELEGRAM_OIDC_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `CDP_API_KEY_ID`,
`CDP_API_KEY_SECRET`, пошта (Cloudflare Email Service після переїзду NS). Без ключа: джерело дає
прогалину з причиною `not configured: <KEY>`, вхід через Telegram ховає кнопку, оплата показує
«скоро», пошта в розробці пише код у журнал (лише не в продакшені).

## 9. Час у базі (обидві доріжки)
- Усі мітки часу: TEXT у форматі SQLite `YYYY-MM-DD HH:MM:SS`, UTC (як `datetime('now')`).
  ISO з `T` і `Z` у базу НЕ пишемо: `'T'` сортується після `' '`, і прострочене виглядає дійсним.
- Краще рахувати в SQL: `datetime('now', '+10 minutes')`. Якщо час приходить з коду, лише через
  спільний помічник `sqlTime(date)` = `date.toISOString().replace('T', ' ').slice(0, 19)`.
- Згоди: `consents` = поточний стан, `consent_events` (0002) = незмінна історія (GDPR ст. 7(1)):
  кожна зміна згоди пише подію в тій самій пакетній транзакції.
- Секрети в базі лише як хеш: `sessions.id` = SHA-256 токена сесії; `login_codes.code_hash` =
  HMAC-SHA256(`SESSION_SECRET`, email + ':' + code).

## 10. Налаштування CRM і оплати (з проєкту CRM, 12.09)
Секрети й змінні Worker: `WEBHOOK_SIGNING_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_ID`,
`X402_NETWORK` ('mainnet' | 'testnet'; обидві мережі Base і Solana разом, див. специфікацію CRM §7.3), `X402_PAY_TO_EVM`, `X402_PAY_TO_SOLANA`,
`CDP_API_KEY_ID`, `CDP_API_KEY_SECRET`; прив'язки лімітів `RL_*` за специфікацією CRM. Дозволено два
лише-індексні доповнення до ядра (індекси на `scores` і `users` у 0003). Двигун для добірок читає
`company_jobs_live` (0004) і пише вакансії компаній у `sent`.
