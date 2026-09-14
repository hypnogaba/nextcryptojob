import { logoResponse } from "@/lib/jobs/logo";
import { jobsDb } from "@/lib/jobs-db";

/**
 * GET /api/logo/<domain>: значок компанії для картки вакансії на /jobs. Лише домени з реєстру
 * роботодавців; решта 404 без жодного запиту назовні. Правила й кеш: lib/jobs/logo.ts.
 */

type Ctx = { params: Promise<{ domain: string }> };

export async function GET(request: Request, { params }: Ctx): Promise<Response> {
  const { domain } = await params;
  return logoResponse(request, domain, { jobs: jobsDb });
}
