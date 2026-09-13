# Встановлення engine на VPS

Worker черги `score_jobs` (systemd, `Restart=always`), щогодинний таймер `enqueue-refresh` і щогодинний
таймер добірки `digest-due` (§6).
Перше встановлення: 12.09.2026 на VPS tradebot (`ssh tradebot-vps`, Ubuntu 22.04, root). На тій самій
машині живуть бойовий торговий бот, сканер NextRole та інші служби: їхніх юнітів, користувачів,
файлів і env не чіпаємо (з `/etc/nextrole-scanner.env` лише читаємо три значення, див. §3).

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
   `CF_API_TOKEN` має читати й D1 `crypto-jobs-agent` (NextRole): нинішній токен зі сканера NextRole
   це вміє (перевірено 12.09 сухим прогоном).
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

Годину, коли нікому не пора, прогін закінчує без жодного читання бази NextRole. Коли пора хоч комусь,
один запит пулу: близько 57 тис. `rows_read` (повний прохід `jobs_cache`, індексу на `fetched_at` там
немає навмисно), що за ціною D1 для читань копійки.

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

## Оновлення

`rsync` нового `dist` (§2), за потреби `npm ci --omit=dev`, далі `systemctl restart nextcryptojob-engine`.
Restart шле SIGTERM: поточні люди дораховуються, що не встигло, повертається в чергу без втраченої спроби
(перевірено 12.09: `stopped: done=0 retried=0 failed=0 requeued=0`, новий процес за 1 с).
