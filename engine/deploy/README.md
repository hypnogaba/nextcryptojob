# Встановлення engine на VPS

Worker черги `score_jobs` (systemd, `Restart=always`), щогодинний таймер `enqueue-refresh`, щогодинний
таймер добірки `digest-due` (§6) і сканер вакансій з власною базою `nextcryptojob-jobs` (§8).
Перше встановлення: 12.09.2026 на VPS tradebot (`ssh tradebot-vps`, Ubuntu 22.04, root). На тій самій
машині живуть бойовий торговий бот, сканер NextRole та інші служби: їхніх юнітів, користувачів,
файлів і env не чіпаємо. 12.09 з `/etc/nextrole-scanner.env` один раз прочитано три значення (§3); з
14.09 NextCryptoJob не залежить від NextRole ні кодом, ні базою, ні службою (§8).

## 1. Користувач і каталоги (один раз)

```sh
useradd --system --user-group --home-dir /var/lib/nextcryptojob-engine --no-create-home \
  --shell /usr/sbin/nologin nextcryptojob
install -d -o root -g root -m 755 /opt/nextcryptojob-engine                         # код, лише читання
install -d -o nextcryptojob -g nextcryptojob -m 750 /var/lib/nextcryptojob-engine  # SELECTOR_CACHE
```

Код належить root і для служби лише читається; писати служба може тільки в `/var/lib/nextcryptojob-engine`
(`StateDirectory=`, `StateDirectoryMode=0750`, `ProtectSystem=strict`).

Node 24: на цьому VPS `/usr/bin/node` це Node 22, а Node 24 (v24.15) стоїть у `/usr/local/bin/node`.
Юніти кличуть `/usr/local/bin/node`; на іншій машині перевірте `node -v` і за потреби виправте `ExecStart`.

## 2. Код

Локально, у `engine/` (Node 24):

```sh
npm ci && npm test && npm run typecheck
rm -rf dist && npm run build
rsync -rlt --delete dist package.json package-lock.json tradebot-vps:/opt/nextcryptojob-engine/
```

(`rsync` на macOS не знає `--chown`; власника ставимо на сервері.) На VPS:

```sh
cd /opt/nextcryptojob-engine
chown -R root:root . && chmod -R u=rwX,go=rX .
PATH=/usr/local/bin:$PATH npm ci --omit=dev --no-audit --no-fund    # лише undici
```

## 3. Змінні оточення

`/etc/nextcryptojob-engine.env`, власник root, права `600` (systemd читає його сам). Значення в
одинарних лапках: так файл читають і systemd, і `set -a; . файл` (перевірено обома). Назви з
`docs/contracts.md` §6; значення лише на сервері, ніколи в git.

Як створено 12.09 (жодне значення не друкувалось і не йшло через переписку):
- `CF_ACCOUNT_ID`, `CF_API_TOKEN`, `TWITTER_TOKEN`: скрипт на VPS узяв їх з `/etc/nextrole-scanner.env`
  (`grep '^KEY=' | cut -d= -f2-`) і дописав у тимчасовий файл `umask 077`, потім `mv`;
- `ETHERSCAN_KEY`: `security find-generic-password -s nextcryptojob-etherscan -a etherscan -w | ssh tradebot-vps …`
  (ключ приходить у stdin скрипту);
- `CF_D1_DATABASE_ID='c66a99cf-230b-4b8b-9cff-862d4b18a4ae'`,
  `SELECTOR_CACHE='/var/lib/nextcryptojob-engine/selectors.json'`, `ENGINE_CONCURRENCY='3'`.

Перевірка, що файл читається, без друку значень:

```sh
bash -c 'set -a; . /etc/nextcryptojob-engine.env; set +a; for k in CF_ACCOUNT_ID CF_D1_DATABASE_ID CF_API_TOKEN TWITTER_TOKEN ETHERSCAN_KEY; do eval "v=\${$k:-}"; echo "$k len=${#v}"; done'
```

Ще немає (у файлі закоментовані рядки-заготовки). Ключа джерела немає: джерело дає прогалину
`not configured: <KEY>`, решта працює (§8):

| Ключ | Без нього |
|---|---|
| `GITHUB_TOKEN` | github і dune = прогалина; ролі з головним gh_eng (engineer, security_auditor без Sherlock) без балу |
| `HELIUS_KEY` | Solana: лише підписи з публічного RPC; обміни відомі тільки для гаманців до 30 успішних транзакцій |
| `BLOCKSCOUT_KEY` | Base і Optimism через публічні сервери Blockscout, які часто відповідають 429 |
| `YOUTUBE_KEY` | youtube = прогалина (media лише з X) |

Необов'язкові налаштування worker:

| Змінна | Типово | Що робить |
|---|---|---|
| `ENGINE_CONCURRENCY` | 3 | скільки людей рахувати одночасно |
| `ENGINE_DEADLINE_MS` | 45000 | межа збору однієї людини; що не встигло, стає прогалиною `timeout`; збирачі отримують її наперед |
| `ENGINE_SHUTDOWN_GRACE_MS` | 60000 | скільки чекати поточні завдання після SIGTERM (менше за `TimeoutStopSec=90`) |
| `SELECTOR_CACHE` | `./data/selectors.json` | кеш назв методів EVM (openchain); на VPS у `/var/lib/nextcryptojob-engine` |

## 4. Юніти

```sh
scp deploy/nextcryptojob-engine.service deploy/nextcryptojob-refresh.service deploy/nextcryptojob-refresh.timer tradebot-vps:/etc/systemd/system/
systemd-analyze verify nextcryptojob-engine.service nextcryptojob-refresh.service nextcryptojob-refresh.timer
systemctl daemon-reload
systemctl enable --now nextcryptojob-engine.service nextcryptojob-refresh.timer
```

Перевірка (12.09: `active (running)`, у журналі `worker: concurrency 3, deadline 45000 ms` і жодної
`queue error`; worker пише рядок лише на завдання або на збій черги):

```sh
systemctl status nextcryptojob-engine
journalctl -u nextcryptojob-engine -n 50      # рядок на завдання: id, префікс id людини, мс, прогалини
systemctl start nextcryptojob-refresh.service && journalctl -u nextcryptojob-refresh -n 5   # доступ до D1
systemctl list-timers nextcryptojob-refresh.timer
```

## 5. Ручні команди

Від імені служби (щоб `selectors.json` лишався її файлом), з тим самим env:

```sh
cd /opt/nextcryptojob-engine
set -a; . /etc/nextcryptojob-engine.env; set +a
runuser -u nextcryptojob -- /usr/local/bin/node dist/cli.js score-user <user-id>        # перерахувати одну людину
runuser -u nextcryptojob -- /usr/local/bin/node dist/cli.js enqueue-refresh [--per-hour N]
runuser -u nextcryptojob -- /usr/local/bin/node dist/cli.js quality-gate <people.json> [cache-dir] [--no-db]
runuser -u nextcryptojob -- /usr/local/bin/node dist/cli.js score-facts --x <нік> --github <логін> \
  --site <url> --evm <0x…> --solana <адреса> [--sherlock <нік>]                               # без D1
```

`score-facts` лише для людей, що погодились (X і GitHub тут вважаються підтвердженими). Замір 12.09 з VPS
для власника (X, GitHub, сайт, 1 EVM, 1 Solana): 7,0 с на весь процес, збір 6,8 с (X найдовший), межа 45 с.

Ворота якості: файл еталону (реальні люди) лежить поза репозиторієм і поза `/opt`; на VPS кладемо його
тимчасово в `/var/lib/nextcryptojob-engine/` (власник nextcryptojob, `600`) і видаляємо після прогону.
У `quality_runs` пишуться лише id. Код виходу 1 (і `passed = 0`), якщо в межах сусіднього рівня менше 85%.
Промахи на 2 рівні з 13.09 не блокують (рішення власника, варіант A): прогін друкує їх і пише в `report_json`
(`twoBandMisses`, `twoBandWithGap`, `twoBandWithoutGap`). Каталог кешу теж містить факти про людей: без
потреби не вказуйте його. `--cache-only` бере факти лише з кешу й падає до збору, якщо чогось бракує;
`--note <текст>` підписує прогін (`report_json.note`, до 200 символів): у `quality_runs` окремої колонки
для цього немає, тож позначка живе в JSON.

Прогони 12.09 з VPS (`people_all.json` + ніки Sherlock з `extra_handles.json`, 49 людей з рівнем, `--no-db`,
межа 45 с, без HELIUS_KEY, BLOCKSCOUT_KEY, YOUTUBE_KEY; GITHUB_TOKEN тимчасово):

| Прогін | exact | within-one | unscored | промахи на 2 рівні | час |
|---|---|---|---|---|---|
| дослідження v5 (кеш фактів) | 42,9% | 85,7% | 1 | 6 | |
| VPS, ENGINE_CONCURRENCY=3 | 38,8% | 73,5% | 6 | 7 | 173 с |
| VPS, ENGINE_CONCURRENCY=1, повтор GraphQL | 40,8% | 81,6% | 3 | 6 | 309 с |

Ворота не пройдено. Причини: прогалини X від 6551 під паралельним навантаженням (6 людей за 3 одночасно,
2 за 1); ключів немає (HELIUS_KEY: 2 трейдери без балу; YOUTUBE_KEY: креатори на рівень нижче); 6551 зараз
віддає KOL 0 для частини людей, які в дослідженні мали 500+; і промахи самої формули v5, що є й на даних
дослідження (другу умову воріт, «жодного промаху на 2 рівні без прогалини», v5 не проходить і там).

Тимчасовий `GITHUB_TOKEN` для ручного прогону (поки його немає в env): лише в оточення одного процесу
через stdin, не на диск: `gh auth token | ssh tradebot-vps 'IFS= read -r GH; …; export GITHUB_TOKEN="$GH"; runuser …'`.

## 6. Добірка вакансій (`digest-due`, задача E7)

Що робить і контракт листа: `src/digest/README.md`. Юніти: `nextcryptojob-digest.service` (oneshot) і
`nextcryptojob-digest.timer` (щогодини о :05, `Persistent=true`).

Перед першим запуском:
1. Controller накочує `db/migrations/0006_digest.sql` на D1 `nextcryptojob` (без неї `digest-due`
   падає на `no such table: digest_runs`). 0011 (`users.digest_paused`) може прийти пізніше: без неї
   пауза не діє, у журналі рядок `digest_paused missing`.
2. Дописати в `/etc/nextcryptojob-engine.env` (без друку значень, як у §3):
   - `TELEGRAM_BOT_TOKEN`: той самий бот, що в сайту (секрет Worker `TELEGRAM_BOT_TOKEN`). Без нього людей
     з каналом Telegram пропускаємо, у базу нічого не пишемо.
   - `SITE_URL='https://nextcryptojob.xyz'`: посилання на вакансії компаній і адреса листа.
   - `INTERNAL_API_SECRET`: той самий секрет, що в сайту для `/api/internal/digest-email`. Поки
     ендпойнта немає (W7) або пошта на сайті не налаштована, добірки поштою стають `failed`
     з `email not configured`.
   `CF_JOBS_D1_DATABASE_ID`: база вакансій `nextcryptojob-jobs` (§8). До 14.09 добірка читала базу
   NextRole; тепер лише власну, і id бази NextRole engine відкидає з поясненням.
3. Сухий прогін з VPS, нічого не пише й не шле:

```sh
cd /opt/nextcryptojob-engine && set -a; . /etc/nextcryptojob-engine.env; set +a
runuser -u nextcryptojob -- /usr/local/bin/node dist/cli.js digest-due --dry-run
runuser -u nextcryptojob -- /usr/local/bin/node dist/cli.js digest-due --dry-run --profile '{"roles":["engineer"],"remote_mode":"remote"}'
```

Встановлення:

```sh
scp deploy/nextcryptojob-digest.service deploy/nextcryptojob-digest.timer tradebot-vps:/etc/systemd/system/
systemd-analyze verify nextcryptojob-digest.service nextcryptojob-digest.timer
systemctl daemon-reload
systemctl enable --now nextcryptojob-digest.timer
systemctl list-timers nextcryptojob-digest.timer
journalctl -u nextcryptojob-digest -n 20   # рядок digest-due: eligible, due, sent, failed, empty, skipped, already
```

Годину, коли нікому не пора, прогін закінчує без жодного читання бази вакансій. Коли пора хоч комусь,
один запит пулу: повний прохід `jobs_cache` (індексу на `fetched_at` там немає навмисно, §8), тобто
кілька тисяч `rows_read`, що за ціною D1 для читань копійки.

## 7. Перехід на формулу v6 (план, 13.09; не викачено)

Що міняється: лише роль «Трейдер» і джерело `trading` (`docs/contracts.md` §4, звіт
`research/trader-calibration-2026-09-13.md`). Решта ролей дає ті самі бали, що v5.

### Як сайт вирішує, чи показувати бал

- Компаніям (пошук CRM, картка кандидата в CRM, воронка, API, MCP) бал показується, лише якщо в
  `quality_runs` є рядок з `formula_version` = версія **цього рядка `scores`** і `passed = 1`
  (`publishedSql()` у `web/src/lib/crm/visibility.ts`, `PUBLISHED` у `search.ts`, `project.ts`, `pipeline.ts`).
  Ворота йдуть по рядку: бал v5 потребує пройденого прогону v5, бал v6 пройденого прогону v6.
- `FORMULA_VERSION` у `web/src/lib/crm/types.ts` потрібна лише для причини порожнього пошуку:
  `scores_not_published`, якщо для чинної версії немає пройденого прогону. На показ балів вона не впливає.
- Людині (свій профіль, `/c/<slug>`, пояснення балу) бал показується без перевірки воріт. Зворот картки
  бере ваги з `breakdown_json`, тож v5 і v6 показуються кожна зі своїми вагами.
- Стан на 13.09 (читання D1 `nextcryptojob`): `quality_runs` порожня. **v5 ворота не пройшла ніколи**, тож
  компанії зараз не бачать жодного балу; пошук з фільтром балу каже `scores_not_published`.
  Прогони 12.09 з VPS були з `--no-db` і не пройшли (таблиця в §5).

### Порядок

Деплоїти лише зі свіжого main після злиття `track/formula-v6` (інакше деплой відкотить інші доріжки).

1. Рушій, локально в `engine/`:

```sh
npm ci && npm test && npm run typecheck && npm run parity   # parity: 0.000 проти score_v6.py
rm -rf dist && npm run build
rsync -rlt --delete dist package.json package-lock.json tradebot-vps:/opt/nextcryptojob-engine/
```

2. На VPS: власник, залежності, перезапуск (поточні люди дораховуються за старою формулою):

```sh
cd /opt/nextcryptojob-engine
chown -R root:root . && chmod -R u=rwX,go=rX .
PATH=/usr/local/bin:$PATH npm ci --omit=dev --no-audit --no-fund
grep -o 'FORMULA_VERSION = "v[0-9]*"' dist/formula/score.js     # має бути v6
systemctl restart nextcryptojob-engine && journalctl -u nextcryptojob-engine -n 20
```

3. Ворота v6 з VPS, спершу без запису. Еталон складається локально з `people_all.json` і ніків Sherlock
   з `extra_handles.json` (як 12.09), лежить на VPS лише на час прогону:

```sh
# локально, у research/data (у git не йде)
umask 077; python3 -c 'import json; p=json.load(open("people_all.json")); e=json.load(open("extra_handles.json")); [x.update(sherlock=e[x["id"]]["sherlock"]) for x in p if e.get(x["id"], {}).get("sherlock")]; json.dump(p, open("/tmp/ncj-people.json", "w"))'
scp /tmp/ncj-people.json tradebot-vps:/var/lib/nextcryptojob-engine/people.json && rm /tmp/ncj-people.json
# на VPS
cd /opt/nextcryptojob-engine && set -a; . /etc/nextcryptojob-engine.env; set +a
chown nextcryptojob:nextcryptojob /var/lib/nextcryptojob-engine/people.json && chmod 600 /var/lib/nextcryptojob-engine/people.json
ENGINE_CONCURRENCY=1 runuser -u nextcryptojob -- /usr/local/bin/node dist/cli.js quality-gate /var/lib/nextcryptojob-engine/people.json --no-db
```

4. Той самий прогін із записом у D1 (рядок пишеться завжди, `passed` = чесний результат; сайт бере лише `passed = 1`):

```sh
ENGINE_CONCURRENCY=1 runuser -u nextcryptojob -- /usr/local/bin/node dist/cli.js quality-gate /var/lib/nextcryptojob-engine/people.json
rm /var/lib/nextcryptojob-engine/people.json
```

5. Перерахувати всіх, чий бал з іншої версії. Звичайний `enqueue-refresh` бере лише людей з фактами,
   старшими за 7 днів, тому для зміни формули є `--stale-formula` (усі з балом не v6, незалежно від віку
   фактів; `--per-hour N` = не більше N за раз). Worker збирає факти заново й пише бали v6:

```sh
runuser -u nextcryptojob -- /usr/local/bin/node dist/cli.js enqueue-refresh --stale-formula
journalctl -u nextcryptojob-engine -f      # рядок на людину; черга порожня = усі на v6
```

6. Сайт з `FORMULA_VERSION = "v6"` (рецепт трейдера 90/10 на головній і картках): звичайний деплой web з
   main. Раніше за рушій не варто: рецепт казав би 90/10, поки зворот картки ще показує бал v5 з 80/20.

### Ворота v6: запис прогону на фактах дослідження

З 13.09 ворота = в межах сусіднього рівня ≥ 85% (варіант A). Правило рушія на кеші фактів дослідження
(без мережі, без запису):

| Формула | exact | within-one | unscored | промахи на 2 рівні | з них з прогалиною | ворота (A) |
|---|---|---|---|---|---|---|
| v5 (як на проді) | 40,8% | 85,7% | 1 | 6 | 1 | пройдено б |
| v6 | 42,9% | 85,7% | 1 | 6 | 1 | пройдено |

5 промахів без прогалини (1 аудитор безпеки, 2 продакти, 1 інженер, 1 креатор) у `docs/BACKLOG.md`.
Живий прогін з VPS без ключів гірший (81,6% для v5 12.09), тому чесний запис для v6 це прогін рушія на
тих самих фактах, що дало дослідження: кеш `quality-gate` з `research/data` робить
`scripts/research-cache.ts` (формат дослідження інший, тож потрібен перекладач; той самий `adaptHarness`,
що в `npm run parity`, скрипт сам звіряє бали з кешу з ним і друкує очікуваний результат воріт).

Локально, з main після злиття `track/gate-a` (рушій з `--cache-only` і `--note` має бути на VPS: §2, §Оновлення):

```sh
cd engine
npx tsc -p tsconfig.scripts.json
OUT=$(mktemp -d /tmp/ncj-gate.XXXXXX)
(umask 077; node dist-scripts/scripts/research-cache.js ../research/data "$OUT")
#   очікуємо: 50 people, 184 source answers, 0 planned sources not in the research data;
#   max diff 0.000; exact 21 (42.9%), within one 42 (85.7%), unscored 1; 2-band misses 6 (1 / 5); PASSED
scp -rq "$OUT" tradebot-vps:/var/lib/nextcryptojob-engine/gate-v6 && rm -rf "$OUT"
```

На VPS:

```sh
G=/var/lib/nextcryptojob-engine/gate-v6
chown -R nextcryptojob:nextcryptojob "$G" && chmod 700 "$G" "$G/cache" && chmod 600 "$G/people.json" "$G"/cache/*.json
cd /opt/nextcryptojob-engine && set -a; . /etc/nextcryptojob-engine.env; set +a
NOTE='research cached facts (raw_all 2026-09-11, raw_extra 2026-09-12), reference set 49, no live collection'
runuser -u nextcryptojob -- /usr/local/bin/node dist/cli.js quality-gate "$G/people.json" "$G/cache" --cache-only --no-db --note "$NOTE"
runuser -u nextcryptojob -- /usr/local/bin/node dist/cli.js quality-gate "$G/people.json" "$G/cache" --cache-only --note "$NOTE"
rm -rf "$G"
```

Очікуваний кінець друку обох прогонів (код виходу 0; сотні балів можуть зсунутись від віку гаманців):

```
formula v6, deadline 45000 ms, people 49: exact 21 (42.9%), within one 42 (85.7%), unscored 1
2-band misses 6 (with a data gap 1, without 5; tracked, not a gate rule)
facts: 184 source answers from cache, 0 collected now
note: research cached facts (raw_all 2026-09-11, raw_extra 2026-09-12), reference set 49, no live collection
quality gate: PASSED (within-one >= 85%)
```

Другий прогін пише рядок `quality_runs`: `formula_version = 'v6'`, `people = 49`, `exact_pct = 42.9`,
`near_pct = 85.7`, `unscored = 1`, `passed = 1`, у `report_json` `rule`, `note`, `facts`, `twoBandMisses`.
Відтоді компанії бачать бали v6. Якщо `facts` показує `collected` > 0 або прогін каже `cache-only: …`,
кеш не збігся з еталоном: нічого не записано (для `--cache-only` падіння до збору), перезібрати кеш тим
самим скриптом. Живий прогін з ключами (крок 4 порядку) лишається наступною перевіркою.

## 8. База вакансій і сканер (`jobs-scan`, 14.09.2026)

Рішення власника 14.09: NextCryptoJob і NextRole розділено повністю. У NextCryptoJob свій сканер
(`src/jobs`, лише крипто) і своя база вакансій D1 `nextcryptojob-jobs` (`db/jobs`). Сайт (binding
`JOBS_DB`) і добірка (`CF_JOBS_D1_DATABASE_ID`) читають лише її. Жодного коду, бази чи служби NextRole
у роботі не лишається. Засів реєстру (`db/jobs/seed`) один раз зроблено з публічних даних бази NextRole
(`scripts/jobs-seed.ts`, лише SELECT); далі реєстр живе сам.

### Що читає сканер

| Джерело | Як | Вимикач | Умови |
|---|---|---|---|
| Роботодавці з реєстру (`companies`, 320 увімкнених з 364) | публічні API ATS: Greenhouse (з `pay_transparency`), Lever і Lever EU, Ashby (з `includeCompensation`), Workable, SmartRecruiters, Recruitee, Teamtailor (RSS), Breezy, BambooHR, Rippling, Personio | `companies.enabled` | API існують, щоб вакансії читали й показували |
| web3.career (`board:web3career`) | розмітка JobPosting на сторінках списку | `sources.enabled` | сторінку умов не прочитати (Cloudflare), robots дозволяє; є офіційний безкоштовний API з токеном, перейти на нього, коли буде токен |
| JobStash (`board:jobstash`) | потік Next.js головної; лише вакансії, які дошка сама позначила крипто | `sources.enabled` | умов немає, robots `Allow: /`. 14.09 їхній бекенд відповідав 503, і головна віддавала каркас: 0 вакансій, скан це переживає |
| Remote3 (`board:remote3`) | їхній RSS `/api/rss` | `sources.enabled` | умови забороняють автоматичні запити до сайту, тому лише їхня стрічка |
| a16z speedrun (`aggregator:speedrun`) | відкритий API, лише крипто-компанії мережі | `JOBS_SPEEDRUN=0` | `/developers`: «reads are open and unauthenticated»; передаємо `?source=nextcryptojob` |
| Superteam Earn (`aggregator:superteam`) | публічний JSON `superteam.fun/api/listings` | **вимкнено**, `JOBS_SUPERTEAM=1` вмикає | баунті, а не вакансії (без зарплати, короткий строк); сторінка умов не прочиталась |
| Колекції Getro (`getro_collections`, 22) | лише щотижнева розвідка посилань на ATS, вакансій з Getro в базі немає | **вимкнено**, `JOBS_GETRO_DISCOVERY=1` вмикає | **ризик**: умови Getro (getro.com/terms, v3.1) забороняють «crawl, scrape or spider» будь-яку частину сервісу, `api.getro.com/robots.txt` `Disallow: /`. Навіть розвідка раз на тиждень читає колекції. Вмикати лише рішенням власника |

Не беремо: cryptocurrencyjobs.co (умови забороняють scrape, crawl і масовий передрук), crypto-careers.com
(забороняє автоматичний збір), cryptojobslist.com (те саме), сторінки ролей web3.career (умови не
підтверджені, той самий вміст дає їхній API).

Правила скану: лише крипто (джерело каже, що крипто, і компанії немає в `engine/src/digest/clean.ts`);
вікно 30 днів від публікації (`JOBS_WINDOW_DAYS`); дедуп за адресою й за ключем «компанія + назва» (лишається
запис із зарплатою); вилка лише річна (`src/jobs/pay.ts`, погодинна й місячна переводяться, незрозуміла не
пишеться). Джерело, що падає 7 днів поспіль, стає `dead` і читається раз на тиждень (`source_state`).

### Скільки це коштує в D1

`jobs_cache` WITHOUT ROWID без вторинних індексів: 1 записаний рядок на вакансію за скан (і нову, і
оновлену), плюс 3 на `scan_runs` і по 1 на зміну стану джерела. Скан насухо 14.09 з Mac: див. таблицю
в кінці розділу. Живий прогін пише справжнє число з `meta.rows_written` у `scan_runs.rows_written`.
Читання: пул сайту раз на 10 хв на ізолят і пул добірки раз на годину, коли комусь пора, це повні
проходи по кількох тисячах рядків.

### Порядок переходу (робить controller; сканер нічого не деплоїть сам)

Добірка після нового `dist` вимагає `CF_JOBS_D1_DATABASE_ID`, а порожня база дала б людям порожню
добірку того дня (`digest_runs` один раз на дату). Тому таймер добірки на час переходу зупиняємо.

1. База й схема (локально, у `web/`, де є вхід wrangler):

```sh
npx wrangler d1 create nextcryptojob-jobs                       # записати database_id
npx wrangler d1 execute nextcryptojob-jobs --remote --file ../db/jobs/0001_schema.sql
npx wrangler d1 execute nextcryptojob-jobs --remote --file ../db/jobs/seed/seed.sql
npx wrangler d1 execute nextcryptojob-jobs --remote --command "SELECT
  (SELECT COUNT(*) FROM companies) AS companies, (SELECT COUNT(*) FROM companies WHERE enabled = 1) AS enabled,
  (SELECT COUNT(*) FROM sources) AS sources, (SELECT COUNT(*) FROM getro_collections) AS getro,
  (SELECT group_concat(name) FROM schema_migrations) AS migrations"
# очікуємо: 364, 320, 4, 22, 0001_schema,seed_registry
```

2. Токен. `CF_API_TOKEN` у `/etc/nextcryptojob-engine.env` має право D1 Edit на `nextcryptojob-jobs`.
   Нинішній токен 12.09 узято з env сканера NextRole (§3): це спільний обліковий запис акаунта, не
   залежність від служби, але ротація токена NextRole зупинила б і NextCryptoJob. Краще окремий токен
   NextCryptoJob (dash.cloudflare.com, My Profile, API Tokens, Custom Token: D1 Edit на обидві бази
   `nextcryptojob` і `nextcryptojob-jobs`), покладений так само, як у §3 (без друку значення).

3. Код (§2): `npm ci && npm test && npm run typecheck && rm -rf dist && npm run build`, `rsync` на VPS,
   `npm ci --omit=dev`. На VPS спершу `systemctl stop nextcryptojob-digest.timer`.

4. Змінні в `/etc/nextcryptojob-engine.env` (одинарні лапки, як у §3):

| Змінна | Потрібна | Що робить |
|---|---|---|
| `CF_JOBS_D1_DATABASE_ID` | так | id бази `nextcryptojob-jobs` з кроку 1. Той самий `CF_ACCOUNT_ID` і `CF_API_TOKEN`. Id бази NextRole і id основної бази engine відкидає |
| `JOBS_WINDOW_DAYS` | ні (30) | вікно від публікації |
| `JOBS_PRUNE_DAYS` | ні (30) | `jobs-prune`: скільки днів скан мав не бачити вакансію |
| `JOBS_SPEEDRUN` | ні (1) | `0` вимикає speedrun у скані й розвідці |
| `JOBS_SUPERTEAM` | ні (0) | `1` вмикає Superteam Earn |
| `JOBS_GETRO_DISCOVERY` | ні (0) | `1` вмикає розвідку посилань з колекцій Getro (ризик умов, вище) |

   Стара змінна `JOBS_D1_DATABASE_ID` (якщо була) більше не читається: прибрати рядок.

5. Сухий прогін з VPS на порожній базі (реєстр з бази, нічого не пише, друкує очікувані записи):

```sh
cd /opt/nextcryptojob-engine && set -a; . /etc/nextcryptojob-engine.env; set +a
runuser -u nextcryptojob -- /usr/local/bin/node dist/cli.js jobs-scan --dry
```

6. Перший справжній скан і перевірка:

```sh
runuser -u nextcryptojob -- /usr/local/bin/node dist/cli.js jobs-scan
# локально, у web/:
npx wrangler d1 execute nextcryptojob-jobs --remote --command "SELECT kind, status, sources_ok, sources_failed,
  jobs_found, jobs_new, rows_written, started_at, finished_at FROM scan_runs ORDER BY started_at DESC LIMIT 3"
npx wrangler d1 execute nextcryptojob-jobs --remote --command "SELECT COUNT(*) AS jobs,
  SUM(fetched_at >= strftime('%Y-%m-%dT%H:%M:%SZ', 'now', '-3 days')) AS live,
  SUM(salary_min IS NOT NULL OR salary_max IS NOT NULL) AS with_salary, COUNT(DISTINCT source) AS sources FROM jobs_cache"
npx wrangler d1 execute nextcryptojob-jobs --remote --command "SELECT source, status, fail_days, last_error FROM source_state ORDER BY fail_days DESC LIMIT 20"
# добірка читає нову базу (нічого не пише й не шле):
runuser -u nextcryptojob -- /usr/local/bin/node dist/cli.js digest-due --dry-run --profile '{"roles":["engineer"],"remote_mode":"remote"}'
```

7. Юніти й таймери, потім знову таймер добірки:

```sh
scp deploy/nextcryptojob-jobs-*.service deploy/nextcryptojob-jobs-*.timer tradebot-vps:/etc/systemd/system/
systemd-analyze verify nextcryptojob-jobs-scan.service nextcryptojob-jobs-scan.timer \
  nextcryptojob-jobs-discover.service nextcryptojob-jobs-discover.timer nextcryptojob-jobs-prune.service nextcryptojob-jobs-prune.timer
systemctl daemon-reload
systemctl enable --now nextcryptojob-jobs-scan.timer nextcryptojob-jobs-discover.timer nextcryptojob-jobs-prune.timer
systemctl start nextcryptojob-digest.timer
systemctl list-timers 'nextcryptojob-*'
journalctl -u nextcryptojob-jobs-scan -n 20
```

   Розклад: скан щодня о 04:30 UTC (і у вихідні: живий пул не худне), розвідка в неділю о 05:30 UTC,
   прибирання в неділю о 06:30 UTC. Час скану збігається з `SCAN_TIME_UTC` у
   `web/src/lib/admin/job-sources.ts` (адмінка рахує пропущені скани від нього).

8. Сайт: у `web/wrangler.jsonc` замість `REPLACE_WITH_NEW_DB_ID` вписати id з кроку 1 (окремий коміт),
   деплой web лише зі свіжого main (`npm run cf:deploy`). Перевірити `/admin/sources` (джерела й
   «Newest scan»), табло головної і `/jobs` («Jobs for you now»).

Відкат: попередній `dist` engine разом зі старим рядком env і попередній деплой web. Посилання з
добірок до переходу (`sent.job_ref = nr:<id старої бази>`) у новій базі не знаходяться: історія на
`/jobs` покаже їх як «gone», а та сама вакансія під новим id може прийти людині ще раз, один раз.

### Скан насухо 14.09.2026 (з Mac, реєстр засіву, без бази)

`env -u CF_JOBS_D1_DATABASE_ID npx tsx src/cli.ts jobs-scan --dry --out dry.json` у `engine/`, типові
налаштування (без Superteam і Getro). Міряно з ноутбука, а не з VPS: відповіді джерел з сервера варто
звірити кроком 5.

| Що | Число |
|---|---|
| Джерела | 324 прочитано (320 роботодавців, web3.career, JobStash, Remote3, speedrun), 0 збоїв |
| Вакансій прочитано | 5 397 |
| Відкинуто | старші за 30 днів 3 346, дублікати 352, не-крипто компанії 100 (Zscaler, Inmobi, Zinnia з web3.career) |
| Записано б у `jobs_cache` | 1 599 (з них 620 web3.career, 959 з ATS 153 роботодавців, 8 Remote3, 12 speedrun) |
| Живий пул (сито добірки) | 1 440 вакансій, 274 компанії, 699 віддалених |
| З вилкою | 780 (54%): web3.career 594, Ashby 127, Greenhouse 105 |
| За ролями (з вилкою) | Engineer 540 (298), Security auditor 69 (35), DevRel 0, Data & research 102 (57), PM 105 (61), BD 133 (63), Marketing 102 (60), Creator/KOL 11 (6), Community 10 (5), Trader 60 (34); поза десятьма: Operations 163, Finance 131, Legal 122, HR 42, Designer 32 |
| Записів D1 за скан | ≈ 1 602 (1 на рядок вакансії + 3 на прогін); ≈ 48 тис. на місяць, близько $0,05 |
| З `JOBS_SUPERTEAM=1` | +22 рядки, пул 1 446 (Creator/KOL 13) |

JobStash того дня віддавав 0 (їхній бекенд відповідав 503, головна лише каркас). Коли він оживе, пул
зросте (у кеші NextRole 13.09 JobStash давав 383 до 601 вакансії пулу, але без жодної зарплати).
Для порівняння: пул з бази NextRole 13.09 був 1 588 (неділя) до 2 089 (п'ятниця) з 22% вилок, і
чверть його давали колекції Getro, умови яких забороняють збір.

## Оновлення

`rsync` нового `dist` (§2), за потреби `npm ci --omit=dev`, далі `systemctl restart nextcryptojob-engine`.
Restart шле SIGTERM: поточні люди дораховуються, що не встигло, повертається в чергу без втраченої спроби
(перевірено 12.09: `stopped: done=0 retried=0 failed=0 requeued=0`, новий процес за 1 с).
