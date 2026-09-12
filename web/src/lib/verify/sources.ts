// Читання публічного профілю для перевірки коду: X через 6551, GitHub через
// REST API. Лише біо й останні пости, нічого не зберігаємо. Кожна відповідь
// зводиться до одного з кількох станів, які анкета пояснює людині.

export type ReadResult<T> =
  | { status: "ok"; data: T }
  /** Такого акаунта немає (лише GitHub каже це напевно). */
  | { status: "not_found" }
  /** Джерело не відповіло як слід: ліміт, тайм-аут, порожні дані. Спробувати пізніше. */
  | { status: "busy" }
  /** Ключ відхилено: сайт налаштований неправильно. */
  | { status: "unavailable" }
  /** Вичерпано годинний ліміт джерела (GitHub): чекати кілька хвилин, а не хвилину. */
  | { status: "source_limited" };

type Fetch = typeof fetch;

const X_API = "https://ai.6551.io/open";
// Виміряно 12.09 з Mac: профіль ~0,6 с, 20 постів 1,4–2,4 с. Запас утричі.
const X_INFO_TIMEOUT_MS = 6000;
const X_POSTS_TIMEOUT_MS = 8000;
const GITHUB_TIMEOUT_MS = 6000;

async function post6551(path: string, body: object, token: string, fetchImpl: Fetch, timeoutMs: number) {
  try {
    const res = await fetchImpl(`${X_API}/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status === 401 || res.status === 403) return { status: "unavailable" as const };
    if (!res.ok) return { status: "busy" as const };
    const json = (await res.json()) as { data?: unknown };
    return { status: "ok" as const, data: json?.data };
  } catch {
    return { status: "busy" as const };
  }
}

/**
 * Біо X. 6551 на ліміт і на неіснуючий нік однаково віддає порожні дані
 * (`data` без screenName), тож обидва випадки = «busy»: людина перевірить нік
 * і спробує ще раз, а не отримає хибне «акаунта немає».
 */
export async function readXBio(handle: string, token: string, fetchImpl: Fetch = fetch): Promise<ReadResult<string>> {
  const res = await post6551("twitter_user_info", { username: handle }, token, fetchImpl, X_INFO_TIMEOUT_MS);
  if (res.status !== "ok") return res;
  const data = res.data as { screenName?: unknown; description?: unknown } | null | undefined;
  if (!data || typeof data.screenName !== "string") return { status: "busy" };
  // Відповідь про інший акаунт не доводить нічого.
  if (data.screenName.toLowerCase() !== handle.toLowerCase()) return { status: "busy" };
  return { status: "ok", data: typeof data.description === "string" ? data.description : "" };
}

type Post = { id?: unknown; conversationId?: unknown; text?: unknown; userScreenName?: unknown };

/**
 * Власний пост, як у рушія (docs/contracts.md §3): не ретвіт («RT @…») і не
 * відповідь (conversationId = id). Ретвіт чужого поста з кодом не доводить,
 * що акаунт твій: інакше досить було б попросити власника ретвітнути.
 */
export function isOwnPost(post: Post, handle: string): boolean {
  if (typeof post?.text !== "string" || post.text.startsWith("RT @")) return false;
  if (typeof post.userScreenName === "string" && post.userScreenName.toLowerCase() !== handle.toLowerCase()) {
    return false;
  }
  if (post.conversationId !== undefined && post.id !== undefined && String(post.conversationId) !== String(post.id)) {
    return false;
  }
  return true;
}

/**
 * Тексти власних постів з останніх 20 X. Порожній список 6551 віддає і на
 * ліміт, тож це «busy», а не «коду немає».
 */
export async function readXPosts(
  handle: string,
  token: string,
  fetchImpl: Fetch = fetch,
): Promise<ReadResult<string[]>> {
  const res = await post6551(
    "twitter_user_tweets",
    { username: handle, maxResults: 20, product: "Latest" },
    token,
    fetchImpl,
    X_POSTS_TIMEOUT_MS,
  );
  if (res.status !== "ok") return res;
  if (!Array.isArray(res.data) || res.data.length === 0) return { status: "busy" };
  const texts = (res.data as Post[]).filter((p) => isOwnPost(p, handle)).map((p) => p.text as string);
  return { status: "ok", data: texts };
}

/**
 * Біо GitHub. Без GITHUB_TOKEN запит іде без ключа: GitHub дає 60 запитів
 * на годину з адреси, для рідкої ручної перевірки цього досить.
 */
export async function readGithubBio(
  login: string,
  token: string | undefined,
  fetchImpl: Fetch = fetch,
): Promise<ReadResult<string>> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "NextCryptoJob",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const res = await fetchImpl(`https://api.github.com/users/${encodeURIComponent(login)}`, {
      headers,
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (res.status === 404) return { status: "not_found" };
    if (res.status === 401) return { status: "unavailable" };
    if (res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")) {
      return { status: "source_limited" };
    }
    if (!res.ok) return { status: "busy" };
    const data = (await res.json()) as { login?: unknown; bio?: unknown };
    if (typeof data?.login !== "string" || data.login.toLowerCase() !== login.toLowerCase()) return { status: "busy" };
    return { status: "ok", data: typeof data.bio === "string" ? data.bio : "" };
  } catch {
    return { status: "busy" };
  }
}
