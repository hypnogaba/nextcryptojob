import { safeEqual } from "../auth/hash";
import {
  BRIDGE_CLIENT_HEADER,
  BRIDGE_HEADERS,
  BRIDGE_KEY_HEADER,
  BRIDGE_SCOPE_HEADER,
  BRIDGE_USER_HEADER,
  SCOPE,
} from "./config";

/**
 * Міст між OAuth у worker.ts і маршрутом сайту /mcp/me.
 *
 * OAuthProvider перевіряє токен і дає людину в ctx.props, але маршрути Next отримують лише запит.
 * Тому Worker кладе людину в заголовки разом із секретом `CONNECTOR_BRIDGE_SECRET`, а маршрут
 * вірить заголовкам лише з цим секретом. Будь-які такі заголовки ззовні Worker знімає з кожного
 * запиту (stripBridge), тож навіть без секрету вони до сайту не доходять.
 */

/** Людина, яку передав Worker після перевірки токена. */
export type BridgedUser = { userId: string; scopes: string[]; clientId: string | null };

/** Знімає заголовки мосту з запиту ззовні: вони мають право з'явитись лише з рук Worker. */
export function stripBridge(request: Request): Request {
  if (!BRIDGE_HEADERS.some((h) => request.headers.has(h))) return request;
  const headers = new Headers(request.headers);
  for (const h of BRIDGE_HEADERS) headers.delete(h);
  return new Request(request, { headers });
}

/** Запит до /mcp/me від імені людини з перевіреного токена. */
export function bridgeRequest(
  request: Request,
  secret: string,
  user: { userId: string; scopes: readonly string[]; clientId?: string | null },
): Request {
  const headers = new Headers(request.headers);
  for (const h of BRIDGE_HEADERS) headers.delete(h);
  // Токен далі не потрібен: сайт його не перевіряє, а в журналах йому не місце.
  headers.delete("authorization");
  headers.set(BRIDGE_USER_HEADER, user.userId);
  headers.set(BRIDGE_SCOPE_HEADER, user.scopes.join(" "));
  if (user.clientId) headers.set(BRIDGE_CLIENT_HEADER, user.clientId.slice(0, 300));
  headers.set(BRIDGE_KEY_HEADER, secret);
  return new Request(request, { headers });
}

const USER_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** Людина з заголовків мосту або null, якщо секрету немає чи він не той. */
export function readBridge(request: Request, secret: string | undefined): BridgedUser | null {
  if (!secret || secret.length < 32) return null;
  const key = request.headers.get(BRIDGE_KEY_HEADER);
  if (!key || !safeEqual(key, secret)) return null;
  const userId = request.headers.get(BRIDGE_USER_HEADER) ?? "";
  if (!USER_ID.test(userId)) return null;
  const scopes = (request.headers.get(BRIDGE_SCOPE_HEADER) ?? "").split(" ").filter(Boolean);
  if (!scopes.includes(SCOPE)) return null;
  return { userId, scopes, clientId: request.headers.get(BRIDGE_CLIENT_HEADER) };
}
