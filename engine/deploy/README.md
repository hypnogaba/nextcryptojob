# Встановлення engine на VPS

Worker черги `score_jobs` (systemd, `Restart=always`) і щогодинний таймер `enqueue-refresh`.
Перед першим запуском `src/pipeline/realRegistry.ts` має бути під'єднаний до збирачів: поки там
заглушка, worker одразу виходить з помилкою `collectors not wired`.

## 1. Користувач і каталоги (один раз)

```sh
sudo useradd --system --home /opt/nextcryptojob-engine --shell /usr/sbin/nologin nextcryptojob
sudo mkdir -p /opt/nextcryptojob-engine
sudo chown nextcryptojob:nextcryptojob /opt/nextcryptojob-engine
```

Потрібен Node 24 (`node -v`). Юніти кличуть `/usr/bin/node`; якщо Node стоїть деінде, виправте `ExecStart`.

## 2. Код

Локально, у `engine/`:

```sh
npm ci && npm test && npm run build
rsync -av --delete dist package.json package-lock.json <vps>:/opt/nextcryptojob-engine/
```

На VPS:

```sh
cd /opt/nextcryptojob-engine && sudo -u nextcryptojob npm ci --omit=dev
```

## 3. Змінні оточення

`/etc/nextcryptojob-engine.env`, власник root, права `600` (systemd читає його сам). Назви з
`docs/contracts.md` §6; значення лише на сервері, ніколи в git:

```
CF_ACCOUNT_ID=
CF_D1_DATABASE_ID=
CF_API_TOKEN=
TWITTER_TOKEN=
ETHERSCAN_KEY=
BLOCKSCOUT_KEY=
HELIUS_KEY=
YOUTUBE_KEY=
GITHUB_TOKEN=
```

Ключа джерела немає: джерело дає прогалину `not configured: <KEY>`, решта працює (§8).
Необов'язкові налаштування worker:

| Змінна | Типово | Що робить |
|---|---|---|
| `ENGINE_CONCURRENCY` | 3 | скільки людей рахувати одночасно |
| `ENGINE_DEADLINE_MS` | 45000 | дедлайн збору однієї людини; що не встигло, стає прогалиною `timeout` |
| `ENGINE_SHUTDOWN_GRACE_MS` | 60000 | скільки чекати поточні завдання після SIGTERM (менше за `TimeoutStopSec=90`) |

## 4. Юніти

```sh
sudo cp deploy/nextcryptojob-engine.service deploy/nextcryptojob-refresh.service deploy/nextcryptojob-refresh.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now nextcryptojob-engine.service nextcryptojob-refresh.timer
```

Перевірка:

```sh
systemctl status nextcryptojob-engine
journalctl -u nextcryptojob-engine -f      # один рядок на завдання: id, префікс id людини, мс, прогалини
systemctl list-timers nextcryptojob-refresh.timer
```

## 5. Ручні команди

```sh
cd /opt/nextcryptojob-engine
set -a; . /etc/nextcryptojob-engine.env; set +a
node dist/cli.js score-user <user-id>                 # перерахувати одну людину зараз
node dist/cli.js enqueue-refresh [--per-hour N]       # те, що робить таймер
node dist/cli.js quality-gate /path/people.json [/path/raw-cache] [--no-db]
```

Ворота якості: файл еталону (реальні люди) лежить поза репозиторієм і поза `/opt`; у `quality_runs`
пишуться лише id. Код виходу 1, якщо в межах сусіднього рівня менше 85% або є промах на 2 рівні
без прогалини в даних. Каталог кешу теж містить факти про людей: тримайте його поруч з еталоном.

## Оновлення

`rsync` нового `dist`, за потреби `npm ci --omit=dev`, далі `sudo systemctl restart nextcryptojob-engine`.
Restart шле SIGTERM: поточні люди дораховуються, що не встигло, повертається в чергу без втраченої спроби.
