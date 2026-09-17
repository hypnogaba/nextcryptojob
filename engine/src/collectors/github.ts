import type { Collected, GithubFacts } from "../types.js";
import { collect, DAY_MS, fitsDeadline, GapError, notConfigured, nowMs, type CollectorContext } from "./context.js";
import { GITHUB_API, GITHUB_LOGIN, githubJson, normalizeLogin } from "./github-api.js";

/**
 * GitHub одним запитом GraphQL (як research/harness/collect_fast.py github):
 * профіль, власні не-форки, останні 100 злитих PR з власником репо, внесок за рік.
 */
export const GITHUB_QUERY = `query($login:String!){ user(login:$login){ createdAt followers{totalCount}
  repositories(ownerAffiliations:OWNER,isFork:false,first:100,orderBy:{field:STARGAZERS,direction:DESC}){
    nodes{ stargazerCount pushedAt homepageUrl } }
  pullRequests(states:MERGED,first:100,orderBy:{field:CREATED_AT,direction:DESC}){
    totalCount nodes{ repository{ owner{ login } } } }
  contributionsCollection{ totalCommitContributions totalPullRequestReviewContributions } } }`;

export type GithubUser = {
  createdAt: string;
  followers: { totalCount: number };
  repositories: { nodes: Array<{ stargazerCount: number; pushedAt: string | null; homepageUrl: string | null } | null> };
  pullRequests: { totalCount: number; nodes: Array<{ repository: { owner: { login: string } | null } | null } | null> };
  contributionsCollection: { totalCommitContributions: number; totalPullRequestReviewContributions: number };
};

type GraphqlResponse = { data?: { user?: GithubUser | null } | null; errors?: Array<{ type?: string; message?: string }> };

/**
 * GraphQL GitHub на важкому профілі (багато репозиторіїв і PR) часом падає на своєму боці:
 * 200, `user: null` і помилка без `type` ("Something went wrong while executing your query"),
 * приблизно за 10 с. Живий прогін 12.09: 2 з 3 викликів на одному профілі. Такий збій повторюємо,
 * поки повтор встигає до межі збору людини.
 */
export const GRAPHQL_RETRIES = 2;
/** Оцінка одного важкого виклику GraphQL для рішення «чи встигне повтор». */
export const GRAPHQL_CALL_ESTIMATE_MS = 12_000;

/** GithubFacts з відповіді GraphQL. Чиста функція. */
export function githubFacts(u: GithubUser, login: string, now: number): GithubFacts {
  const repos = u.repositories.nodes.filter((r): r is NonNullable<typeof r> => r != null);
  const prs = u.pullRequests.nodes.filter((p): p is NonNullable<typeof p> => p != null);
  const me = login.toLowerCase();
  const elsewhere = prs.filter((p) => (p.repository?.owner?.login ?? "").toLowerCase() !== me).length;
  // Частка чужих серед останніх 100, перенесена на весь totalCount (оцінка, як у дослідженні).
  const share = prs.length ? elsewhere / prs.length : 0;
  const yearAgo = now - 365 * DAY_MS;
  return {
    createdAt: u.createdAt,
    followers: u.followers.totalCount,
    stars: repos.reduce((s, r) => s + (r.stargazerCount || 0), 0),
    commits12m: u.contributionsCollection.totalCommitContributions,
    reviews12m: u.contributionsCollection.totalPullRequestReviewContributions,
    mergedPrsElsewhere: Math.round(u.pullRequests.totalCount * share),
    reposPushed12m: repos.filter((r) => r.pushedAt != null && Date.parse(r.pushedAt) > yearAgo).length,
    reposWithSite: repos.filter((r) => (r.homepageUrl ?? "").trim() !== "").length,
  };
}

/** Скільки комітів у чужий репозиторій робить його командним. */
export const TEAM_MIN_COMMITS = 20;
/** Скільки останніх років переглядаємо (GitHub дає внесок лише вікнами до року). */
export const TEAM_YEARS = 10;
/** Оцінка запиту командної роботи: він необов'язковий, тож робимо його, лише коли встигаємо. */
export const TEAM_CALL_ESTIMATE_MS = 8_000;

type YearWindow = { commitContributionsByRepository: Array<{ contributions: { totalCount: number };
  repository: { nameWithOwner: string; stargazerCount: number; isFork: boolean; owner: { login: string } } | null } | null> };

/** Один запит: внесок за кожен рік (аліаси y<рік>), від року створення акаунта, не більше TEAM_YEARS. */
export function teamQuery(createdAt: string, now: number): string {
  const last = new Date(now).getUTCFullYear();
  const born = new Date(createdAt).getUTCFullYear();
  const first = Math.max(Number.isFinite(born) ? born : last, last - TEAM_YEARS + 1);
  const years: string[] = [];
  for (let y = first; y <= last; y++) {
    years.push(`y${y}: contributionsCollection(from:"${y}-01-01T00:00:00Z", to:"${y}-12-31T23:59:59Z"){ ` +
      "commitContributionsByRepository(maxRepositories:10){ contributions{totalCount} " +
      "repository{ nameWithOwner stargazerCount isFork owner{ login } } } }");
  }
  return `query($login:String!){ user(login:$login){ ${years.join(" ")} } }`;
}

/** Командні репозиторії з відповіді: чужі, не форки, від TEAM_MIN_COMMITS комітів разом за роки. Чиста функція. */
export function teamWork(windows: Record<string, YearWindow | null> | null | undefined, login: string): { teamStars: number; teamCommits: number } {
  const me = login.toLowerCase();
  const repos = new Map<string, { stars: number; commits: number }>();
  for (const w of Object.values(windows ?? {})) {
    for (const c of w?.commitContributionsByRepository ?? []) {
      const r = c?.repository;
      if (!r || r.isFork || (r.owner?.login ?? "").toLowerCase() === me) continue;
      const cur = repos.get(r.nameWithOwner) ?? { stars: r.stargazerCount || 0, commits: 0 };
      cur.commits += c.contributions?.totalCount || 0;
      repos.set(r.nameWithOwner, cur);
    }
  }
  let teamStars = 0, teamCommits = 0;
  for (const r of repos.values()) {
    if (r.commits < TEAM_MIN_COMMITS) continue;
    teamStars += r.stars;
    teamCommits += r.commits;
  }
  return { teamStars, teamCommits };
}

/** Командна робота або null: запит необов'язковий, збій не робить GitHub прогалиною. */
async function collectTeamWork(login: string, createdAt: string, ctx: CollectorContext): Promise<{ teamStars: number; teamCommits: number } | null> {
  if (!fitsDeadline(ctx, TEAM_CALL_ESTIMATE_MS)) return null;
  try {
    const res = await githubJson<{ data?: { user?: Record<string, YearWindow | null> | null } | null }>(`${GITHUB_API}/graphql`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ query: teamQuery(createdAt, nowMs(ctx)), variables: { login } }),
    }, ctx);
    const user = res?.data?.user;
    return user ? teamWork(user, login) : null;
  } catch (e) {
    if (ctx.signal?.aborted) throw e;
    return null;
  }
}

export async function collectGithub(login: string, ctx: CollectorContext): Promise<Collected<GithubFacts>> {
  return collect("github", ctx, async () => {
    if (!ctx.env.GITHUB_TOKEN) throw notConfigured("GITHUB_TOKEN");
    const me = normalizeLogin(login);
    if (!GITHUB_LOGIN.test(me)) throw new GapError("invalid login");
    for (let attempt = 0; ; attempt++) {
      const res = await githubJson<GraphqlResponse>(`${GITHUB_API}/graphql`, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json" },
        body: JSON.stringify({ query: GITHUB_QUERY, variables: { login: me } }),
      }, ctx);
      const user = res?.data?.user;
      if (user) {
        const facts = githubFacts(user, me, nowMs(ctx));
        const team = await collectTeamWork(me, user.createdAt, ctx);
        return team ? { ...facts, ...team } : facts;
      }
      const errors = res?.errors ?? [];
      const types = errors.map((e) => e?.type).filter(Boolean);
      if (types.includes("NOT_FOUND")) throw new GapError("user not found");
      // Збій на боці GitHub (помилка без type): повтор, якщо встигне.
      const serverSide = errors.length > 0 && types.length === 0;
      if (serverSide && attempt < GRAPHQL_RETRIES && fitsDeadline(ctx, GRAPHQL_CALL_ESTIMATE_MS)) continue;
      if (serverSide) throw new GapError(`GraphQL failed on GitHub's side after ${attempt + 1} attempt(s)`);
      throw new GapError(`GraphQL returned no user${types.length ? ` (${types.join(", ")})` : ""}`);
    }
  });
}
