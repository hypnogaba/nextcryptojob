import { handleConnector } from "@/lib/api/mcp-me";

/**
 * Особистий MCP людини для AI-помічників (lib/api/mcp-me.ts). Вхід OAuth робить worker.ts:
 * сюди доходить лише запит з людиною від нього, решта отримує 401.
 */
const serve = (request: Request) => handleConnector(request);

export { serve as DELETE, serve as GET, serve as OPTIONS, serve as POST };
