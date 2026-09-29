#!/bin/sh
# Сповіщення власнику в Telegram, що systemd-юніт NextCryptoJob впав (викликає nextcryptojob-notify@.service).
# Використання: nextcryptojob-notify-failure <ім'я юніта>
#
# Змінні беруться з /etc/nextcryptojob-engine.env (EnvironmentFile юніта), у репозиторії їх немає:
#   NCJ_OWNER_TG_BOT_TOKEN  токен бота для власника (без нього береться TELEGRAM_BOT_TOKEN сайту)
#   NCJ_OWNER_TG_CHAT_ID    chat id власника (число; бот мусить мати право писати в цей чат)
# Немає токена чи чату: пише в stderr (journal) і виходить з кодом 0, щоб самому сповіщенню нічого не ламати.
# Токен передається curl через stdin (-K -), а не в аргументах: у `ps` його не видно.
unit="${1:-unknown-unit}"
token="${NCJ_OWNER_TG_BOT_TOKEN:-${TELEGRAM_BOT_TOKEN:-}}"
chat="${NCJ_OWNER_TG_CHAT_ID:-}"

if [ -z "$token" ] || [ -z "$chat" ]; then
  echo "nextcryptojob-notify-failure: NCJ_OWNER_TG_CHAT_ID or a bot token is not set, no message sent for $unit" >&2
  exit 0
fi

host="$(hostname -s 2>/dev/null || echo vps)"
# Кілька останніх рядків журналу юніта, коротко. Права на journal бувають не в усіх: тоді без хвоста.
tail_lines="$(journalctl -u "$unit" -n 5 --no-pager -o cat 2>/dev/null | cut -c1-200)" || tail_lines=""
text="NextCryptoJob: ${unit} failed on ${host} at $(date -u '+%Y-%m-%d %H:%M UTC')"
if [ -n "$tail_lines" ]; then
  text="${text}
${tail_lines}"
fi

# Довжина повідомлення Telegram обмежена (4096): різати з запасом.
text="$(printf '%s' "$text" | cut -c1-3500)"

printf 'url = "https://api.telegram.org/bot%s/sendMessage"\n' "$token" |
  curl -sS -K - --max-time 20 -o /dev/null \
    --data-urlencode "chat_id=${chat}" \
    --data-urlencode "text=${text}" \
    --data-urlencode "disable_web_page_preview=true" ||
  echo "nextcryptojob-notify-failure: Telegram request failed for $unit" >&2
exit 0
