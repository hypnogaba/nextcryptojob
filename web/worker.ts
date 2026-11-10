// Власна точка входу Worker (специфікація CRM 3.6): fetch від OpenNext і scheduled для cron-тригерів
// з wrangler.jsonc. Як радить OpenNext: https://opennext.js.org/cloudflare/howtos/custom-worker
// .open-next/worker.js з'являється лише після `npm run cf:build`, тому перед збіркою TypeScript його не бачить.
//
// Над OpenNext стоїть OAuthProvider (@cloudflare/workers-oauth-provider): конектор для AI-помічників
// (lib/oauth/config.ts). Він сам відповідає на /.well-known/oauth-*, /oauth/token і /oauth/register,
// пускає на /mcp/me лише з чинним токеном, а все інше без змін віддає сайту.
import { OAuthProvider, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { default as handler } from "./.open-next/worker.js";
import { scheduledHandler, type CronEnv } from "./src/lib/cron";
import { handleAuthorize } from "./src/lib/oauth/authorize";
import { bridgeRequest, stripBridge } from "./src/lib/oauth/bridge";
import {
  ACCESS_TOKEN_TTL_S,
  AUTHORIZE_PATH,
  CONNECTOR_PATH,
  CONNECTOR_RESOURCE,
  type ConnectorProps,
  OAUTH_ISSUER,
  REFRESH_TOKEN_IDLE_TTL_S,
  REGISTER_PATH,
  SCOPE,
  TOKEN_PATH,
} from "./src/lib/oauth/config";

type Env = CloudflareEnv & { OAUTH_PROVIDER: OAuthHelpers; CONNECTOR_BRIDGE_SECRET?: string };

const runScheduled = scheduledHandler();

/** Сайт: сторінка згоди конектора, решту OpenNext. Заголовки мосту ззовні не пропускаємо ніколи. */
const site = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const clean = stripBridge(request);
    if (new URL(clean.url).pathname === AUTHORIZE_PATH) return handleAuthorize(clean, env);
    return handler.fetch(clean, env, ctx);
  },
};

/** /mcp/me з чинним токеном: людина з гранту йде маршруту сайту заголовками мосту (lib/oauth/bridge.ts). */
const connector = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext & { props: ConnectorProps; auth?: { scope?: string[]; clientId?: string } }) {
    const secret = env.CONNECTOR_BRIDGE_SECRET;
    if (!secret) return Response.json({ error: "connector_unavailable" }, { status: 503 });
    const bridged = bridgeRequest(request, secret, {
      userId: ctx.props.userId,
      scopes: ctx.auth?.scope ?? [],
      clientId: ctx.auth?.clientId ?? null,
    });
    return handler.fetch(bridged, env, ctx);
  },
};

const oauth = new OAuthProvider<Env>({
  apiRoute: CONNECTOR_PATH,
  apiHandler: connector as never,
  defaultHandler: site as never,
  authorizeEndpoint: AUTHORIZE_PATH,
  tokenEndpoint: TOKEN_PATH,
  clientRegistrationEndpoint: REGISTER_PATH,
  scopesSupported: [SCOPE, "offline_access"],
  requiredScopes: [SCOPE],
  resourceMetadata: { resource: CONNECTOR_RESOURCE, authorization_servers: [OAUTH_ISSUER] },
  accessTokenTTL: ACCESS_TOKEN_TTL_S,
  refreshTokenIdleTTL: REFRESH_TOKEN_IDLE_TTL_S,
  clientIdMetadataDocumentEnabled: true,
});

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) => oauth.fetch(request, env, ctx),
  // Чекаємо весь запуск тут (await), не в ctx.waitUntil: waitUntil у scheduled
  // обривається приблизно за 30 с після виходу з обробника (src/lib/cron/index.ts).
  async scheduled(controller, env) {
    await runScheduled(controller, env as unknown as CronEnv);
  },
} satisfies ExportedHandler<Env>;

// Durable Objects, які експортує точка входу OpenNext (у нас не прив'язані, але
// лишаємо експорт таким самим, як у згенерованому worker.js).
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from "./.open-next/worker.js";
