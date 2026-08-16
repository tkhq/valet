import process from "node:process";

/**
 * The GitHub API base URL every request in this package goes through.
 * `GITHUB_API_URL` retargets it — a GitHub Enterprise Server host in
 * production, and the loopback fixture server in the action suites. The name
 * and the default match `resolveGithubApiUrl` in
 * `packages/api/src/services/github-env.ts`, so one variable moves the whole
 * product off api.github.com.
 */
export function resolveGithubApiUrl(): string {
  return process.env.GITHUB_API_URL || 'https://api.github.com';
}

/**
 * Stateless authenticated fetch against the GitHub API.
 * @deprecated Use Octokit instead. Kept temporarily for repo provider files until Task 21.
 */
export async function githubFetch(
  path: string,
  token: string,
  options?: RequestInit,
): Promise<Response> {
  return fetch(`${resolveGithubApiUrl()}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'Valet/1.0',
      ...options?.headers,
    },
  });
}
