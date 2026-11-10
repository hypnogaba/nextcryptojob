import { AuthorizationError, CimdFetchError, type ConsentDescription, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { sha256Hex } from "../auth/hash";
import { AUTHORIZE_PATH, type ConnectorProps, RETURN_COOKIE, RETURN_MAX_AGE_S, SCOPE, SCOPE_WORDS } from "./config";

/**
 * Сторінка згоди конектора: GET і POST /oauth/authorize (lib/oauth/config.ts).
 *
 * Без імпортів Next: її викликає worker.ts до OpenNext, тож сесію читаємо самі з куки
 * `ncj_session` тим самим способом, що lib/auth/session.ts (у базі лише SHA-256 токена).
 * Без сесії людина йде на /login і повертається сюди тим самим запитом.
 *
 * Безпека (docs бібліотеки, consent-page.md): усе, що прийшло від клієнта (назва, домен,
 * хост переадресації), екранується; сторінку не можна вбудувати в чужий кадр (заголовки
 * beginConsent); форма несе лише одноразовий handle, прив'язаний до цього браузера, а сам
 * запит авторизації береться зі сховища, не з форми.
 */

const SESSION_COOKIE = "ncj_session";
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

type AuthorizeEnv = { DB: D1Database; OAUTH_PROVIDER: OAuthHelpers };

type SessionRow = { id: string; email: string | null; channel: string | null; tg: string | null };

/** Людина за кукою сесії сайту або null. */
export async function sessionUser(request: Request, d: D1Database): Promise<SessionRow | null> {
  const token = readCookie(request.headers.get("cookie"), SESSION_COOKIE);
  if (!token || !TOKEN_SHAPE.test(token)) return null;
  return d
    .prepare(
      `SELECT u.id, u.email, u.channel, u.telegram_username AS tg
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > datetime('now')`,
    )
    .bind(await sha256Hex(token))
    .first<SessionRow>();
}

export function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** Обробник /oauth/authorize. Помилки клієнта показує сам, збій сховища кидає далі (500). */
export async function handleAuthorize(request: Request, env: AuthorizeEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  try {
    if (request.method === "GET") return await showConsent(request, env);
    if (request.method === "POST") {
      const user = await sessionUser(request, env.DB);
      if (!user) return page("Sign in again", "<p>Your session ended. Go back to your AI app and connect again.</p>", 401);
      const form = await request.formData();
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = await oauth.denyConsent(request, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = await oauth.approveConsent(request, handle, { scope: [SCOPE] });
      const props: ConnectorProps = { userId: user.id };
      const { redirectTo } = await oauth.completeAuthorization({
        request: approved.request,
        userId: user.id,
        metadata: {},
        scope: approved.request.scope,
        props,
      });
      approved.headers.set("Location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    if (error instanceof AuthorizationError) return page("Cannot connect", `<p>${escapeHtml(error.description)}</p>`, 400);
    if (error instanceof CimdFetchError) return page("Cannot connect", "<p>This app could not be verified.</p>", 400);
    throw error;
  }
}

async function showConsent(request: Request, env: AuthorizeEnv): Promise<Response> {
  const oauth = env.OAUTH_PROVIDER;
  // Спершу перевірка запиту: хибний клієнт чи адреса не мають вести навіть на вхід.
  const authRequest = await oauth.parseAuthRequest(request);
  const user = await sessionUser(request, env.DB);
  if (!user) {
    const url = new URL(request.url);
    const next = `${AUTHORIZE_PATH}${url.search}`;
    const headers = new Headers({ Location: `/login?next=${encodeURIComponent(next)}`, "Cache-Control": "no-store" });
    // Для входу через Telegram, який ?next= не несе (app/auth/telegram/callback).
    headers.append(
      "Set-Cookie",
      `${RETURN_COOKIE}=${encodeURIComponent(next)}; Path=/; Max-Age=${RETURN_MAX_AGE_S}; HttpOnly; Secure; SameSite=Lax`,
    );
    return new Response(null, { status: 302, headers });
  }
  const details = await oauth.describeConsent(authRequest);
  const consent = await oauth.beginConsent(authRequest);
  consent.headers.set("Content-Type", "text/html; charset=utf-8");
  consent.headers.set("Cache-Control", "no-store");
  return new Response(consentHtml(details, consent.handle, user), { headers: consent.headers });
}

function who(user: SessionRow): string {
  if (user.email) return user.email;
  if (user.tg) return `@${user.tg} on Telegram`;
  return "your NextCryptoJob account";
}

export function consentHtml(details: ConsentDescription, handle: string, user: SessionRow): string {
  const name = escapeHtml(details.clientName);
  const origin = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : "This app registered itself, so we cannot confirm its name.";
  const loopback = details.redirectIsLoopback
    ? `<p class="warn"><strong>This sends access to an app on your computer.</strong> Continue only if you just started connecting from it.</p>`
    : "";
  const rights = SCOPE_WORDS.map((w) => `<li>${escapeHtml(w)}</li>`).join("");
  const body = `
<p class="lead">Allow <strong>${name}</strong> to use NextCryptoJob as ${escapeHtml(who(user))}?</p>
<p>${origin} Access goes to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${loopback}
<p>It will be able to:</p>
<ul>${rights}</ul>
<p class="muted">It cannot see your wallets, X or GitHub details, message companies, or delete your account. You can disconnect it at any time in your AI app.</p>
<form method="post">
  <input type="hidden" name="handle" value="${escapeHtml(handle)}">
  <div class="row">
    <button class="primary" name="decision" value="approve">Allow</button>
    <button name="decision" value="deny">Deny</button>
  </div>
</form>`;
  return html(`Connect ${name}`, body);
}

function page(title: string, body: string, status: number): Response {
  return new Response(html(escapeHtml(title), body), {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self'",
    },
  });
}

/** Проста сторінка без скриптів у кольорах сайту (світла й темна тема). */
function html(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} · NextCryptoJob</title>
<style>
:root{color-scheme:light dark;--bg:#fafaf7;--ink:#14140f;--muted:#5d5d55;--line:#d9d9d0;--accent:#1f5eff;--warn:#9a3b00}
@media (prefers-color-scheme:dark){:root{--bg:#121210;--ink:#f2f2ec;--muted:#a3a39a;--line:#34342e;--accent:#7aa2ff;--warn:#ffb27a}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}
main{max-width:520px;margin:0 auto;padding:48px 16px}
.brand{font-weight:700;letter-spacing:-.01em;margin-bottom:32px}
h1{font-size:24px;line-height:1.25;margin:0 0 16px}
.lead{font-size:18px}.muted{color:var(--muted);font-size:14px}.warn{color:var(--warn)}
ul{padding-left:20px}li{margin:4px 0}
.row{display:flex;gap:12px;margin-top:24px}
button{font:inherit;padding:10px 20px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
</style></head>
<body><main><div class="brand">NextCryptoJob</div><h1>${title}</h1>${body}</main></body></html>`;
}
