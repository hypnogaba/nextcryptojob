import { escapeHtml } from "@/lib/mail/digest";

/**
 * Маленька сторінка для посилань із листів (відгук, «Still looking?»): без JS, як сторінка відписки
 * (app/api/digest/unsubscribe/route.ts). GET нічого не міняє, бо сканери посилань у поштових скриньках
 * відкривають їх без людини; зміна лише POST-ом із кнопки.
 */

export const PAGE_HEADERS = {
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
label{display:flex;gap:8px;align-items:center;min-height:32px;color:var(--i)}
button{min-height:44px;border:0;border-radius:8px;background:var(--b);color:var(--bi);font:inherit;font-weight:600;padding:0 20px;cursor:pointer}
a{color:var(--b);font-weight:500}`;

export function simplePage(status: number, title: string, body: string): Response {
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex">` +
    `<title>${escapeHtml(title)} | NextCryptoJob</title><style>${STYLE}</style></head>` +
    `<body><main><div class="card"><h1>${escapeHtml(title)}</h1>${body}</div></main></body></html>`;
  return new Response(html, { status, headers: PAGE_HEADERS });
}

export const badLinkPage = () =>
  simplePage(403, "This link does not work.", `<p>Open your <a href="/settings">settings</a> instead.</p>`);
