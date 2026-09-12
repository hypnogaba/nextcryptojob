import type { Fetched, GithubFacts } from "../types.js";
import { collect, DAY_MS, GapError, notConfigured, nowMs, type CollectorContext } from "./context.js";
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

export async function collectGithub(login: string, ctx: CollectorContext): Promise<Fetched<GithubFacts>> {
  return collect("github", ctx, async () => {
    if (!ctx.env.GITHUB_TOKEN) throw notConfigured("GITHUB_TOKEN");
    const me = normalizeLogin(login);
    if (!GITHUB_LOGIN.test(me)) throw new GapError("invalid login");
    const res = await githubJson<GraphqlResponse>(`${GITHUB_API}/graphql`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ query: GITHUB_QUERY, variables: { login: me } }),
    }, ctx);
    const user = res?.data?.user;
    if (!user) {
      const types = (res?.errors ?? []).map((e) => e?.type).filter(Boolean);
      if (types.includes("NOT_FOUND")) throw new GapError("user not found");
      throw new GapError(`GraphQL returned no user${types.length ? ` (${types.join(", ")})` : ""}`);
    }
    return githubFacts(user, me, nowMs(ctx));
  });
}
