import { handleMcp } from "@/lib/api/mcp";

/**
 * MCP-сервер (docs/api/mcp-tools.md): streamable HTTP без стану, інструменти з
 * реєстру дій. Усе в lib/api/mcp.ts; GET, POST, DELETE і OPTIONS ведуть в один обробник.
 */
const serve = (request: Request) => handleMcp(request);

export { serve as DELETE, serve as GET, serve as OPTIONS, serve as POST };
