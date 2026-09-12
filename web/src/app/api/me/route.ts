import { currentUser } from "@/lib/auth/session";

/**
 * Чи є сесія. Потрібно шапці сайту: вона статична (головна, /privacy, /terms
 * віддаються без Worker-рендера), тож стан входу дізнається цим запитом з
 * браузера. Без куки відповідь без жодного запиту до бази. Пошти й id не віддаємо.
 */
export async function GET() {
  const user = await currentUser();
  return Response.json(
    { signedIn: user !== null },
    { headers: { "Cache-Control": "private, no-store" } },
  );
}
