// Налаштовує @nextcryptojob_bot через Bot API: вебхук, команди (/start, /jobs, /help, /stop), кнопка
// меню зі списком команд і опис. Запускає контролер (власник) руками, з токеном бота з оточення:
// після деплою маршруту /api/telegram/webhook, після зміни команд чи опису нижче (напр. 14.09.2026
// додано /jobs) і після переїзду на інший домен (адреса вебхука живе в Telegram, не в коді).
// Аватар бота власник ставить сам у @BotFather: скрипт його не чіпає.
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
// Ті самі команди, що розуміє lib/telegram/bot.ts.
await call("setMyCommands", {
  commands: [
    { command: "jobs", description: "The last jobs we sent you" },
    { command: "start", description: "How it works, or turn daily jobs back on" },
    { command: "help", description: "How it works and all commands" },
    { command: "stop", description: "Pause daily jobs" },
  ],
});
// Кнопка меню біля поля вводу відкриває цей список команд.
await call("setChatMenuButton", { menu_button: { type: "commands" } });
// Опис бачить людина в порожньому чаті до /start (до 512 символів).
await call("setMyDescription", {
  description:
    "Crypto jobs that fit you, every day.\n\n" +
    "1. On nextcryptojob.xyz tell us in your own words what job you want, your roles, remote or a city, and your minimum pay.\n" +
    "2. Every day at your hour we check every live crypto job we have and send you the 5 that fit you best, here or by email.\n" +
    "3. Each job says why it fits and links straight to the application.\n\n" +
    "/jobs shows the jobs we sent you, /stop pauses them.",
});
await call("setMyShortDescription", {
  short_description: "Your 5 best-fitting crypto jobs every day, with the reasons why.",
});

const info = await call("getWebhookInfo");
const me = await call("getMe");
const commands = await call("getMyCommands");
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
      commands: commands.map((c) => `/${c.command}`),
    },
    null,
    2,
  ),
);
