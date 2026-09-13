import { handleRest } from "@/lib/api/rest";

/**
 * REST API компаній (docs/api/openapi.yaml, 28 операцій). Тонкий маршрут: шлях і
 * метод зіставляє з реєстром дій lib/api/rest.ts, там же розбір, актор і відповідь.
 */
const serve = (request: Request) => handleRest(request);

export { serve as DELETE, serve as GET, serve as PATCH, serve as POST, serve as PUT };
