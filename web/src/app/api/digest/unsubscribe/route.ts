import { appEnv, db } from "@/lib/db";
import { pauseDigest, unsubscribeKey, verifyUnsubscribe } from "@/lib/digest/unsubscribe";
import { escapeHtml } from "@/lib/mail/digest";

/**
 * Відписка з листа добірки (lib/digest/unsubscribe.ts).
 * GET: маленька сторінка з кнопкою, нічого не змінює. POST: пауза, 200.
 * Сторінки прості й без JS: їх відкривають із пошти, часто на телефоні.
 */

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
  // У адресі підпис: не віддаємо його сайтам, куди людина піде далі.
  "Referrer-Policy": "no-referrer",
};

// Кольори з globals.css (ground, surface, ink, ink-muted, line, brand), світла й темна тема.
const STYLE = `
:root{color-scheme:light;--g:#f3f5f4;--s:#fff;--i:#141a1b;--m:#58646a;--l:#d5dcda;--b:#0b6e63;--bi:#fff}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--g:#0e1213;--s:#151b1c;--i:#e4eae8;--m:#95a2a1;--l:#2a3436;--b:#4cc2ae;--bi:#0e1213}}
body{margin:0;background:var(--g);color:var(--i);font:16px/1.5 ui-sans-serif,system-ui,sans-serif}
main{max-width:28rem;margin:0 auto;padding:48px 16px}
.card{background:var(--s);border:1px solid var(--l);border-radius:12px;padding:20px;display:grid;gap:12px}
h1{font-size:20px;line-height:1.3;margin:0}p{margin:0;color:var(--m)}
button{min-height:44px;border:0;border-radius:8px;background:var(--b);color:var(--bi);font:inherit;font-weight:600;padding:0 20px;cursor:pointer}
a{color:var(--b);font-weight:500}`;

function page(status: number, title: string, body: string): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
    `<title>${escapeHtml(title)} | NextCryptoJob</title><style>${STYLE}</style></head>` +
    `<body><main><div class="card"><h1>${escapeHtml(title)}</h1>${body}</div></main></body></html>`;
  return new Response(html, { status, headers: HEADERS });
}

const BAD_LINK = () =>
  page(403, "This link does not work.", `<p>Pause daily jobs in <a href="/settings">settings</a> instead.</p>`);

async function checked(request: Request): Promise<string | null> {
  const key = unsubscribeKey(appEnv());
  return key ? verifyUnsubscribe(key, new URL(request.url).searchParams) : null;
}

export async function GET(request: Request): Promise<Response> {
  if (!(await checked(request))) return BAD_LINK();
  // Без action форма шле POST на ту саму адресу з тим самим підписом.
  return page(
    200,
    "Pause daily jobs?",
    `<p>You stop getting daily jobs by email and in Telegram. You can turn them back on in settings.</p>` +
      `<form method="post"><button type="submit">Pause daily jobs</button></form>`,
  );
}

export async function POST(request: Request): Promise<Response> {
  const userId = await checked(request);
  if (!userId) return BAD_LINK();
  await pauseDigest(db(), userId);
  return page(
    200,
    "Daily jobs are paused.",
    `<p>We will not send you daily jobs. Turn them back on in <a href="/settings">settings</a>.</p>`,
  );
}
