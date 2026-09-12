// Налаштовує @nextcryptojob_bot через Bot API: вебхук, команди й опис.
// Запускати після деплою маршруту /api/telegram/webhook і після переїзду на
// інший домен (адреса вебхука живе в Telegram, не в коді).
//
//   TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... \
//     node scripts/telegram-bot-setup.mjs https://nextcryptojob.hypnogaba.workers.dev
//
// Обидва значення беруться з оточення й нікуди не друкуються. Секрет вебхука
// мусить збігатися з Worker secret TELEGRAM_WEBHOOK_SECRET, інакше маршрут
// відповідатиме Telegram 401.

const token = process.env.TELEGRAM_BOT_TOKEN?.trim();
const secret = process.env.TELEGRAM_WEBHOOK_SECRET?.trim();
const origin = process.argv[2];

if (!token || !secret || !origin || !/^https:\/\/[^/]+$/.test(origin)) {
  console.error("usage: TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=... node scripts/telegram-bot-setup.mjs https://<host>");
  process.exit(2);
}

async function call(method, payload = {}) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({ ok: false, description: `http ${res.status}` }));
  if (!body.ok) throw new Error(`${method}: ${body.description ?? res.status}`);
  return body.result;
}

const webhook = `${origin}/api/telegram/webhook`;

await call("setWebhook", {
  url: webhook,
  secret_token: secret,
  allowed_updates: ["message", "callback_query"],
  drop_pending_updates: true,
});
await call("setMyCommands", {
  commands: [
    { command: "start", description: "What NextCryptoJob is" },
    { command: "help", description: "What this bot can do" },
    { command: "stop", description: "Stop daily jobs in Telegram" },
  ],
});
await call("setMyDescription", {
  description:
    "NextCryptoJob turns your public crypto work into a score and sends you jobs that fit it. " +
    "Sign in on the site with Telegram to get your daily jobs here.",
});
await call("setMyShortDescription", {
  short_description: "Crypto jobs that fit your public work, every day.",
});

const info = await call("getWebhookInfo");
const me = await call("getMe");
console.log(
  JSON.stringify(
    {
      bot: `@${me.username}`,
      webhook: info.url,
      matches: info.url === webhook,
      pending_update_count: info.pending_update_count,
      allowed_updates: info.allowed_updates,
      last_error_date: info.last_error_date ?? null,
      last_error_message: info.last_error_message ?? null,
    },
    null,
    2,
  ),
);
