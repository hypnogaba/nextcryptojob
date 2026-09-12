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
У `quality_runs` пишуться лише id. Код виходу 1, якщо в межах сусіднього рівня менше 85% або є промах
на 2 рівні без прогалини в даних. Каталог кешу теж містить факти про людей: без потреби не вказуйте його.

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

## Оновлення

`rsync` нового `dist` (§2), за потреби `npm ci --omit=dev`, далі `systemctl restart nextcryptojob-engine`.
Restart шле SIGTERM: поточні люди дораховуються, що не встигло, повертається в чергу без втраченої спроби
(перевірено 12.09: `stopped: done=0 retried=0 failed=0 requeued=0`, новий процес за 1 с).
