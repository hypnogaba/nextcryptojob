import { appEnv } from "@/lib/db";
import type { CheckDeps } from "./check";

/**
 * Ключі джерел для перевірки. У Worker це secrets. У `next dev` прив'язки
 * беруться з .dev.vars, тож ключ з оточення оболонки теж приймаємо: так його
 * не треба класти у файл.
 */
export function sourceTokens(): Pick<CheckDeps, "twitterToken" | "githubToken"> {
  const env = appEnv();
  const dev = process.env.NODE_ENV !== "production";
  return {
    twitterToken: env.TWITTER_TOKEN || (dev ? process.env.TWITTER_TOKEN : undefined) || undefined,
    githubToken: env.GITHUB_TOKEN || (dev ? process.env.GITHUB_TOKEN : undefined) || undefined,
  };
}
