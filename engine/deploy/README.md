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
| Роботодавці з реєстру (`companies`, 325 увімкнених з 369 після доповнення 14.09) | публічні API ATS: Greenhouse (з `pay_transparency`), Lever і Lever EU, Ashby (з `includeCompensation`), Workable, SmartRecruiters, Recruitee, Teamtailor (RSS), Breezy, BambooHR, Rippling, Personio | `companies.enabled` | API існують, щоб вакансії читали й показували |
| web3.career (`board:web3career`) | лише офіційний Web3 Jobs API з токеном `WEB3CAREER_TOKEN` (`src/jobs/sources/web3career.ts`), з 14.09 | `sources.enabled` | умови API обов'язкові, див. «web3.career: офіційний API» нижче. Сторінки сайту скан не читає (`fetchBoard` відмовляє будь-якій адресі web3.career) |
| JobStash (`board:jobstash`) | потік Next.js головної; лише вакансії, які дошка сама позначила крипто | `sources.enabled` | умов немає, robots `Allow: /`. 14.09 їхній бекенд відповідав 503, і головна віддавала каркас: 0 вакансій, скан це переживає |
| Remote3 (`board:remote3`) | їхній RSS `/api/rss` | `sources.enabled` | умови забороняють автоматичні запити до сайту, тому лише їхня стрічка |
| a16z speedrun (`aggregator:speedrun`) | відкритий API, лише крипто-компанії мережі | `JOBS_SPEEDRUN=0` | `/developers`: «reads are open and unauthenticated»; передаємо `?source=nextcryptojob` |
| Superteam Earn (`aggregator:superteam`) | публічний JSON `superteam.fun/api/listings` | **вимкнено**, `JOBS_SUPERTEAM=1` вмикає | баунті, а не вакансії (без зарплати, короткий строк); сторінка умов не прочиталась |
| Дошки екосистем і фондів на Getro (`job_boards`, 26 з рішенням `discover`) | лише щотижнева розвідка: список компаній дошки і сторінка вакансій лише невідомої реєстру компанії, звідки береться адреса її ATS; вакансій і текстів Getro в базі немає | **увімкнено на VPS з 14.09** (`JOBS_GETRO_DISCOVERY=1`, рішення власника); `0` вимикає, у коді типово 0 | **ризик прийнято**: умови Getro (getro.com/terms, v3.1) забороняють «crawl, scrape or spider» будь-яку частину сервісу, `api.getro.com/robots.txt` `Disallow: /`. Обсяг малий: див. «Дошки екосистем і фондів» нижче |

Не беремо: cryptocurrencyjobs.co (умови забороняють scrape, crawl і масовий передрук), crypto-careers.com
(забороняє автоматичний збір), cryptojobslist.com (те саме), сторінки web3.career (лише їхній API).

Правила скану: лише крипто (джерело каже, що крипто, і компанії немає в `engine/src/digest/clean.ts`);
вікно від публікації за родом джерела: власна дошка роботодавця на ATS 90 днів (`JOBS_ATS_WINDOW_DAYS`), дошки
й агрегатори 30 (`JOBS_WINDOW_DAYS`); та сама межа в пулі добірки й сайту, де вакансія ще й мусить бути в
останньому вдалому скані свого джерела (`src/digest/jobs.ts`); дедуп за адресою й за ключем «компанія + назва» (лишається
запис із зарплатою); вилка лише річна (`src/jobs/pay.ts`, погодинна й місячна переводяться, незрозуміла не
пишеться). Джерело, що падає 7 днів поспіль, стає `dead` і читається раз на тиждень (`source_state`).

### web3.career: офіційний API

Документація: https://docs.bondex.app/api-reference (Web3.Career Jobs API). Токен власника лежить у
`/etc/nextcryptojob-engine.env` як `WEB3CAREER_TOKEN` (root, 600) і в Keychain Mac
(`security find-generic-password -s nextcryptojob-web3career-token -w`). Без токена джерело падає з
причиною «немає WEB3CAREER_TOKEN» (видно в `source_state` і в адмінці), сторінок сайту скан однаково не читає.

Умови (лист web3.career власнику 14.09 і рядок умов у кожній відповіді API), порушення = доступ знімуть:

1. Вести людину на `apply_url` посиланням follow: у `rel` немає `nofollow` (ні `ugc`, ні `sponsored`).
2. `apply_url` не міняти: не додавати `utm_source`, `utm_medium`, `ref` чи будь-що, мітки вже всередині.
3. Токен лише наш і лише для нашого сайту: не друкувати, не комітити, лише через env.
4. Називати web3.career джерелом (рядок відповіді API: «mention web3.career as a source»).

Як це виконано:

- Сканер пише в `jobs_cache.url` рядок `apply_url` байт у байт (без `cleanUrl`, без `new URL().toString()`).
  Id рядка з номера вакансії (`web3career:<id>`, `RawJob.idKey`), а не з адреси: мітки в адресі не
  множать рядки. Дедуп за ключем «компанія + назва» як і для решти.
- Сайт: одне місце, що вирішує `rel`, `web/src/lib/jobs/link.ts` (`externalJobLink`): для web3.career
  `rel="noopener"` (без `noreferrer`, щоб вони бачили перехід від нас) і `target="_blank"`, для решти
  дошок як було, `noopener noreferrer nofollow`. `safeUrl` лише перевіряє адресу, не нормалізує.
  Підпис «via web3.career» на `/jobs`, у стрічці головної, у листі й у Telegram (`engine/src/digest/deliver.ts`
  `jobVia`). `search_jobs` (REST і MCP) віддає `url` без змін і поле `via: "web3.career"`; опис інструмента
  й `docs/api/openapi.yaml` кажуть агентам не міняти адресу й не ставити nofollow.
- Тести: `engine/src/jobs/sources/web3career.test.ts`, `engine/src/jobs/scan.test.ts` (адреса в базі
  байт у байт, токен не потрапляє ні в `source_state`, ні в `scan_runs`, ні в журнал),
  `web/src/lib/jobs/link.test.ts` (помічник і сторож: файли, що показують вакансії, не пишуть `rel` самі,
  у коді сайту немає `utm_` чи `ref=`), тести `/jobs`, стрічки, листа, Telegram і `/public/jobs`.

Запити: API без сторінок (кожен запит дає до 100 найсвіжіших за фільтром, тег один на запит, невідомий
тег мовчки дає порожньо). 30 днів покриваються зрізами (`WEB3CAREER_QUERIES`): найсвіжіші, усі віддалені,
США за сімома тегами, 13 інших країн, три широкі теги й теги ролей, яких бракує (developer-relations,
community-manager, moderator, discord, social-media, ambassador, kol, marketing, growth, trader, security,
smart-contract), плюс решта ролей добірки. Разом 51 запит на скан, скан раз на добу: 51 запит і близько
40 МБ на день. Ліміт запитів API не називає (лише 429 при надмірі): запити по одному з паузою 1,5 с
(бюджет `web3career` у `src/limits.ts`), скан триває близько 80 с; 429 перечікуємо паузою 2, 4, 8 с (стеля
10 с) і зупиняємось, беручи зібране; 401 і 403 не повторюємо. Токен у рядку запиту маскує `redact`
(`src/http.ts`, параметр `token`), помилки ще й чистить `hideToken`.

Сухий прогін 14.09.2026 з Mac, лише це джерело (`jobs-scan --dry --registry <лише board:web3career>`, токен
з Keychain через env, у базу нічого): 51 запит, 3 176 різних вакансій, у вікні 30 днів 364 (відкинуто
не-крипто компаній 10, дублікатів 2), пул добірки 336, з вилкою 121 (36%), віддалених 51, 128 компаній.
За ролями (з вилкою): Engineer 113 (50), Security auditor 18 (9), DevRel 0, Data & research 22 (6),
PM 32 (14), BD 27 (5), Marketing 28 (5), Creator/KOL 4 (0), Community 6 (1), Trader 7 (1), Designer 6 (2),
Operations 30 (9), Finance 30 (10), Legal 41 (13), HR 8 (6). Тег developer-relations за 30 днів не має
жодної вакансії (найсвіжіша понад рік тому).

Проти бази того ж дня (живий пул 1 439, з них web3.career 577, лише SELECT): з 336 вакансій API 320 уже
є в пулі як ті самі вакансії web3.career, 14 є під іншою адресою (той самий ключ «компанія + назва»),
нових 2. 274 з 620 вакансій, що сканер брав зі сторінок, API не віддає жодним зі 147 перевірених зрізів
(Bitpanda 38, Alpaca 32, DV Trading 19, Binance 17, Blockchain.com 16, BitGo 15, OKX 13 …). Вилка: зі
сторінок web3.career ми брали їхню оцінку зарплати як вилку (215 з 217 вакансій, де роботодавець вилки не
дав, збіглися з `estimated_*` API). Тому 779 «з зарплатою» в живому пулі містять 555 оцінок web3.career.

### Оцінка зарплати web3.career (db/jobs/0002)

API віддає оцінку дошки окремо (`estimated_min_salary`/`max`); скан пише її в `salary_est_min`,
`salary_est_max`, `salary_est_currency` (міграція `db/jobs/0002_salary_estimate.sql`) і лише для вакансії
без вилки роботодавця (ні полем, ні в тексті). У `salary_min`/`salary_max` вона не йде ніколи, тож підбір
добірки за зарплатою, фільтр `salary_min` у `search_jobs`, лічильник «з зарплатою» на головній, «Salary
listed» у поясненні й розмітка JobPosting її не бачать (у добірці вона навіть не в `DigestJob`, а окремою
мапою `estimates` з `loadCrawlPool`). Показ лише приглушеним підписом «est. $180k to $225k (web3.career
estimate)»: `/jobs`, «Jobs for you now», стрічка головної (після всіх вакансій із зарплатою роботодавця у
своїй ролі), лист (поле контракту `salary_estimate`), Telegram (окремий рядок). `search_jobs` віддає окреме
поле `salary_estimate` з `source: "web3.career"`.

### Роботодавці, чиїх вакансій API не віддає

Усі 22 роботодавці з трьома й більше такими вакансіями мають публічну дошку ATS, живу 14.09. 17 уже були в
реєстрі (Bitpanda, Alpaca, Binance, Blockchain.com, BitGo, OKX, FalconX, Figure Markets, Copper, TaxBit,
GSR, B2C2, Tether, Brave, LayerZero, Ondo Finance, Grayscale); їхні вакансії не доходили до бази, бо
дублікат з web3.career перемагав (оцінку ми тоді рахували вилкою). П'ять додано (`CURATED` у
`scripts/jobs-seed.ts`, Greenhouse Job Board API, публічний API для показу вакансій на чужих сайтах):
DV Trading (`dvtrading`), tastylive (`tastylive`), Localcoin (`localcoin`), Blue Cube Services
(`bluecubeservices`), BCB Group (`bcbgroup`, хост EU). Жодного не пропущено за умовами чи через брак ATS.

Із 230 «зниклих» вакансій цих 22 роботодавців: 88 відкриті й опубліковані за 30 днів (тепер у пулі з
дошки роботодавця), 73 відкриті, але роботодавець опублікував їх понад 30 днів тому (web3.career показував
їх зі своєю, пізнішою датою; вікно скану рахує дату роботодавця), 69 на дошці роботодавця немає (закриті або
копії однієї вакансії під різні міста, як 25 з 38 у Bitpanda).

### Дошки екосистем і фондів (`job_boards`, 14.09.2026)

Рішення власника 14.09: вакансії з дошок екосистем (jobs.solana.com, jobs.arbitrum.io …) і фондів
(talent.cyber.fund, jobs.multicoin.capital …) тягнути обов'язково, але малим обсягом: дошка лише каже, які
там компанії й де їхній ATS, а вакансії йдуть з публічного API ATS роботодавця, як і решта реєстру.

Реєстр дошок: таблиця `job_boards` (`db/jobs/0003_job_boards.sql`), джерело правди `db/jobs/seed/boards.json`
(65 дошок, кожна перевірена своєю сторінкою 14.09: `__NEXT_DATA__` → `network.id` для Getro, `consider.com` у
розмітці для Consider). Рішення:

| Рішення | Дошки |
|---|---|
| `discover`, Getro (26) | екосистеми Solana 858, Arbitrum 4184, Avalanche 10223, Monad 13457, Injective 13490, Polkadot 11180, Filecoin 1486; фонди cyber.fund 9035, Multicoin 390, Polychain 203, Dragonfly 1118, Electric Capital 1640, Coinbase Ventures 1625, Framework 1127, Variant 1508, Placeholder 922, Castle Island 13362, Jump Crypto 20916, Delphi 1440, Spartan 1179, Animoca 6230, Blockchain Capital 815, Outlier Ventures 1524, Galaxy Ventures 9134, Bitkraft 3095; Blockchain Association 869 |
| `manual` (Consider, 3) | a16z crypto, Paradigm, Hashed: дошку не читаємо ніколи (умови Consider), роботодавців з публічної сторінки портфеля фонду додано руками |
| `manual` (без дошки, 4) | 1kx, Mechanism, Robot Ventures (публічні сторінки портфеля), Protocol Labs network (os.pl.xyz, власний довідник, прочитано один раз) |
| `skip` (32) | Consider без публічного портфеля (Pantera, Lemniscap, Fenbushi); порожня (Tezos) чи мертва дошка (Cosmos, TON, Algorand); власні дошки без ATS (Sui на HireChain, Aptos, Starknet, Berachain на Polymer, YZi Labs); екосистеми без дошки, чиї фонди й лабораторії вже в реєстрі (Ethereum, Optimism, Base, Polygon, NEAR, ZKsync, Celestia, Sei, Chainlink, Hedera, Stellar, Cardano); фонди без дошки й без списку в розмітці (Hack VC, Alliance, Portal, DWF, IOSG, HashKey, OKX Ventures, Kraken Ventures) |

`crypto_scope`: `all` для екосистем і крипто-фондів; `tagged` (крипто або без галузі за Getro) для
Coinbase Ventures, Galaxy Ventures і Blockchain Association; `strict` (лише названі крипто) для ігрового
Bitkraft. Список не-крипто компаній добірки (`src/digest/clean.ts`) діє завжди.

Як ходить розвідка (`jobs-discover`, неділя 05:30 UTC, `JOBS_GETRO_DISCOVERY=1`), `src/jobs/discover.ts`:

1. Список компаній кожної дошки (`search/companies`, 12 на сторінку, стеля `JOBS_GETRO_MAX_PAGES`=50).
2. Компанію без відкритих вакансій, не крипто за `crypto_scope` або вже відому реєстру за назвою
   («Ethena Labs» = «Ethena», але «Solana Foundation» ≠ «Solana Labs») пропускаємо без жодного запиту.
3. Для решти одна сторінка її вакансій (`search/jobs` з `organization.id`), з якої береться лише адреса:
   ATS, який скан читає, стає кандидатом; адреса на сайт роботодавця = одна-дві його сторінки
   (`src/jobs/sources/careers.ts`) у пошуках ATS; вакансія, вписана прямо в Getro, = «лише на Getro».
4. Нова дошка ATS мусить відповісти своїм API (перевірка тим самим кодом скану), і лише тоді рядок
   `companies` (`discovered_via = 'getro:<id>'`, примітка: яка дошка, яке посилання, скільки відкрито).
5. Компанії лише на Getro, на чужому ATS (Notion, LinkedIn, Wellfound, Gem, Dover, Workday…) і без ATS на
   сторінці кар'єри в реєстр не йдуть: окремими списками в журналі й у `scan_runs.notes`.

Запити до Getro по одному, не частіше ніж раз на 1,5 с (`limits.ts`). Сухий прогін 14.09 з Mac: 393 запити,
11 хвилин, плюс сторінки кар'єри самих роботодавців. Щоденний скан Getro не читає; назв, текстів і зарплат
Getro ніде немає. Ризик умов Getro (заборона crawl/scrape, `robots.txt` `Disallow: /`) прийнято власником.
Вимкнути все: `JOBS_GETRO_DISCOVERY=0`; одну дошку: `UPDATE job_boards SET decision = 'skip' WHERE slug = …`.

Сухий прогін розвідки 14.09 (реєстр засіву, `JOBS_SPEEDRUN=0`, у базу нічого): 26 дошок, 1 741 компанія,
693 з вакансіями, 636 крипто. За назвою вже в реєстрі 338 (засів NextRole колись читав ті самі колекції); з
решти ATS видно у 58 (55 з посилання, 3 зі сторінки кар'єри), з них 45 дошок уже в реєстрі під іншою назвою,
нових 11 (Solana Foundation, cyber•Fund, Neutron, Rated Labs, Sweatcoin, Pixion Games, Kiln, Citrea, Fence,
Inca Digital, Pocket Worlds; останню вакансії без слова про крипту, тож вона в списку не-крипто компаній).
Не читаються: лише на Getro 25 компаній (Nasdaq, Aleph Zero, Arcade, SkyTrade, Brine, самі фонди…), на чужому
ATS 76 (Notion 25, LinkedIn 12, Wellfound 12, Gem 7, Dover 5…), сторінка кар'єри без адреси ATS 96 (Circle,
Bitget, OneKey, MakerDAO, MegaETH, Katana, PoolTogether…; їхні сторінки малюють список скриптом). Слаг за
назвою не вгадуємо: `jobs.ashbyhq.com/circle` це Circle.so, `/katana` це Katana MRP, не крипто.

Руками (Consider і фонди без дошки, `engine/scripts/portfolio-ats.ts`: сторінка портфеля → сайт компанії →
її ATS → жива відповідь API): a16z crypto 7, Paradigm 4, Hashed 1, 1kx 3, Mechanism 4, Robot Ventures 1,
Protocol Labs 2, плюс Cardano Foundation і IOG з перевірки екосистем. Разом з розвідкою 34 нових роботодавці
(`db/jobs/seed/boards-companies-2026-09-14.json`, 369 → 403 у реєстрі), усі з приміткою, звідки відомо.

Сухий скан лише цих 34 (`jobs-scan --dry --registry`, 14.09): 91 вакансія, у вікні 30 днів 13, у пулі добірки
10, усі нові для живого пулу (звірка з `jobs_cache` лише SELECT за id і ключем «компанія + назва»): Engineer 3,
PM 1, BD 2 (1 з вилкою), Marketing 2, Operations 2; з вилкою 1 з 10. Повний сухий скан з новим реєстром:
пул 1 281 (1 272 без них), з вилкою 369 (29%).

Перевірка jobs.solana.com, фільтр функцій Marketing & Communications, Operations, Sales & Business
Development (функції Community у Getro немає; назву з «community» має одна вакансія, Enjoyoors на Notion):
80 вакансій. У живому пулі вже 13; у компаній, яких скан уже читає з їхнього ATS, ще 39, але роботодавець
опублікував їх понад 30 днів тому (Rain, Coinflow, Squads, Phantom …; вони відкриті, вікно скану й добірки 30
днів від дати роботодавця); на сторінці компанії чи чужому ATS 19 (Dover, Gem, Notion, Deel, HiBob, власні
сторінки); лише на Getro 8; Perle 1 (не-крипто). Нові роботодавці з дошок не додали жодної з цих 80. Тобто
для маркетингу, BD й операцій головне обмеження не покриття дошок, а вікно 30 днів: 21 з тих 39
за датою, коли їх побачив Getro, молодші за 90 днів.

### Правило «жива вакансія» (track/open-window, 14.09.2026)

Жива = є в останньому вдалому скані свого джерела (найсвіжіший `fetched_at` джерела; джерело впало: 3 доби
від його останнього вдалого скану) і не старша від публікації (без дати від `first_seen_at`) за 90 днів для
власного фіду роботодавця на ATS або 30 днів для дошки чи агрегатора. Рід джерела з префікса `source`
(`<ats>:<slug>` з відомим провайдером), міграції немає. Добірка бере спершу опубліковані за 30 днів, давніші
лише добирають до п'яти з рядком «Still open, posted N weeks ago.».

Сухий скан з Mac (реєстр засіву, 363 джерела, ті самі сирі вакансії під старим і новим правилом): рядків у базу
1 434 → 2 743 (+1 309 записів D1 на скан); пул добірки 1 281 → 2 417, з вилкою 370 (29%) → 716 (30%), компаній
254 → 314; 1 173 з 2 417 давніші за 30 днів, усі з фідів ATS. BD 119 → 244, Marketing 96 → 177, Operations
144 → 251, Community 10 → 12, Creator/KOL 11 → 14, Trader 48 → 96. jobs.solana.com (Marketing/Ops/BD, 80): у
пулі 13 → 30; ще 15 у фіді роботодавця, але опубліковані понад 90 днів тому, 4 відсіяні ситом ролей чи як
дублікат, 31 не на ATS, який ми читаємо.
Із 73 вакансій ери web3.career, старших за 30 днів, 36 молодші за 90.

Жива база 14.09 (лише SELECT): з 2 050 рядків старе правило бере 2 047, нове 1 419; різниця це 620 рядків
`board:web3career` з читання сторінок (07:12 UTC), яких скан через API (08:34) уже не бачив, плюс 11 знятих
з Lever і Greenhouse. Читання запиту пулу 2 050 → 8 370 рядків (вікно PARTITION BY source), звіту адмінки
4 613 → 10 933: при $0.001 за мільйон це копійки.

Розкачування: engine (скан і добірка) перш за сайт; новий скан уже пише 90-денні рядки, старий сайт їх не бере.
Далі сайт. Міграції немає.

Накочування (controller, по порядку):

1. `npx wrangler d1 execute nextcryptojob-jobs --remote --file ../db/jobs/0003_job_boards.sql`
2. `npx wrangler d1 execute nextcryptojob-jobs --remote --file ../db/jobs/seed/update-2026-09-14-boards.sql`
   (65 рядків `job_boards` і 34 роботодавці; повторне накочування нічого не міняє, змінене руками не чіпає).
   Перевірка: `SELECT (SELECT COUNT(*) FROM job_boards) AS boards, (SELECT COUNT(*) FROM job_boards WHERE decision = 'discover') AS discover,
   (SELECT COUNT(*) FROM companies) AS companies` → 65, 26, 403 (якщо розвідка ще нічого не додала).
3. Новий `dist` engine (§2). Скан від `job_boards` не залежить; розвідка без таблиці впала б з помилкою,
   тому спершу кроки 1 і 2.
4. `/etc/nextcryptojob-engine.env`: `JOBS_GETRO_DISCOVERY='1'` (як у §3, одинарні лапки). Перший прогін
   можна насухо: `runuser -u nextcryptojob -- /usr/local/bin/node dist/cli.js jobs-discover --dry --out /tmp/discover.json`.

### Сухий прогін усіх джерел 14.09.2026 (після обох правок)

`env -u CF_JOBS_D1_DATABASE_ID WEB3CAREER_TOKEN=… npx tsx src/cli.ts jobs-scan --dry` з Mac, реєстр засіву
(325 роботодавців): 329 джерел, 0 збоїв, прочитано 7 938, записано б 1 420 (web3.career 348).

| Що | Живий пул 14.09 | Після переходу |
|---|---|---|
| Пул добірки | 1 439 | 1 272 (-12%) |
| З вилкою роботодавця | 779 (54%, з них 555 оцінок web3.career) | 368 (29%) |
| Лише з оцінкою web3.career (підпис «estimate») | 0 | 188 |
| З вилкою або оцінкою | 779 | 556 (44%) |

За ролями, пул (з вилкою роботодавця) [+ лише з оцінкою]: Engineer 540 → 464 (143) [+55], Security 69 → 59
(16) [+8], DevRel 0 → 0, Data 102 → 93 (26) [+16], PM 104 → 98 (35) [+15], BD 133 → 118 (26) [+21],
Marketing 102 → 93 (30) [+20], Creator/KOL 11 → 11 (2) [+4], Community 10 → 10 (2) [+5], Trader 60 → 48 (5)
[+6], Designer 32 → 30 (8) [+4], Operations 163 → 140 (33) [+17], Finance 130 → 113 (36) [+17], Legal
122 → 109 (27) [+21], HR 42 → 40 (19) [+2]. Нові роботодавці в пулі: DV Trading 16, tastylive 8, Blue Cube 3,
Localcoin 2, BCB 0; з реєстру зросли Alpaca 11 → 25, Binance 13 → 25, Bitpanda 0 → 6, FalconX 0 → 7, BitGo 1 → 4.

### Порядок накочування (controller)

1. `npx wrangler d1 execute nextcryptojob-jobs --remote --file ../db/jobs/0002_salary_estimate.sql`
   (до нового engine і сайту: обидва читають і пишуть нові стовпці; без них пул сайту не прочитається).
2. `npx wrangler d1 execute nextcryptojob-jobs --remote --file ../db/jobs/seed/update-2026-09-14-web3career.sql`
   (п'ять роботодавців і нові feed_url/terms_note web3.career; повторне накочування нічого не міняє).
3. `WEB3CAREER_TOKEN` у `/etc/nextcryptojob-engine.env` (уже є), новий `dist` engine.
4. Деплой сайту зі свіжого main. Старий engine поля `salary_estimate` у листі не шле; сайт його не вимагає.

Перехід: старі рядки web3.career (адреси сторінок) скан більше не оновлює, за 3 доби вони випадуть з
пулу, `jobs-prune` прибере їх за 30 днів; до того дубль відсікає ключ «компанія + назва». Рядок
`sources` у базі лишається (`kind` 'jsonld', бо так велить CHECK; скан бере цю дошку за назвою).

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
npx wrangler d1 execute nextcryptojob-jobs --remote --file ../db/jobs/0002_salary_estimate.sql
npx wrangler d1 execute nextcryptojob-jobs --remote --file ../db/jobs/0003_job_boards.sql
npx wrangler d1 execute nextcryptojob-jobs --remote --file ../db/jobs/seed/seed.sql
npx wrangler d1 execute nextcryptojob-jobs --remote --file ../db/jobs/seed/update-2026-09-14-boards.sql
npx wrangler d1 execute nextcryptojob-jobs --remote --command "SELECT
  (SELECT COUNT(*) FROM companies) AS companies, (SELECT COUNT(*) FROM companies WHERE enabled = 1) AS enabled,
  (SELECT COUNT(*) FROM sources) AS sources, (SELECT COUNT(*) FROM getro_collections) AS getro,
  (SELECT group_concat(name) FROM schema_migrations) AS migrations"
# очікуємо: 403, 359, 4, 22, 0001_schema,0002_salary_estimate,0003_job_boards,registry_2026_09_14_boards,seed_registry
# (свіжа база з новим seed.sql; seed.sql уже має роботодавців з дошок, файл дошок додає job_boards)
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
| `JOBS_WINDOW_DAYS` | ні (30) | вікно від публікації для дошок і агрегаторів |
| `JOBS_ATS_WINDOW_DAYS` | ні (90) | вікно від публікації для власних дошок роботодавців на ATS |
| `JOBS_PRUNE_DAYS` | ні (30) | `jobs-prune`: скільки днів скан мав не бачити вакансію |
| `JOBS_SPEEDRUN` | ні (1) | `0` вимикає speedrun у скані й розвідці |
| `JOBS_SUPERTEAM` | ні (0) | `1` вмикає Superteam Earn |
| `JOBS_GETRO_DISCOVERY` | так, `'1'` (рішення власника 14.09) | розвідка з дошок Getro реєстру `job_boards` (ризик умов прийнято, «Дошки екосистем і фондів» нижче); `0` вимикає, без рядка вимкнено |
| `JOBS_GETRO_MAX_PAGES` | ні (50) | стеля сторінок списку компаній на одну дошку (12 компаній на сторінку) |
| `WEB3CAREER_TOKEN` | так, для web3.career | токен Web3 Jobs API (вище «web3.career: офіційний API»). Лише тут, root 600; ніде не друкувати й не комітити. Без нього `board:web3career` падає з причиною |

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
