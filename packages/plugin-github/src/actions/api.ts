import process from "node:process";
import { Octokit } from "octokit";

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
 * The longest rate-limit wait one request sleeps through before it fails.
 * Octokit's default handlers sleep until the quota resets, up to an hour,
 * and that sleep does not watch the action's abort signal. A turn waiting
 * there could not be stopped. A longer wait fails at once, and
 * `rateLimitError` names the reset time.
 */
export const MAX_RATE_LIMIT_WAIT_SECONDS = 10;

function retryShortWait(retryAfter: number, options: { request: { retryCount: number } }): boolean {
  return options.request.retryCount === 0 && retryAfter <= MAX_RATE_LIMIT_WAIT_SECONDS;
}

/** The one Octokit constructor for this package. */
export function githubOctokit(token: string): Octokit {
  return new Octokit({
    auth: token,
    baseUrl: resolveGithubApiUrl(),
    throttle: { onRateLimit: retryShortWait, onSecondaryRateLimit: retryShortWait },
  });
}

/**
 * The message for a request GitHub refused for rate limiting, or undefined
 * for any other error. It says when the limit resets, so the agent can tell
 * the person instead of retrying at once.
 */
export function rateLimitError(err: unknown, operation: string, now = Date.now()): string | undefined {
  const e = err as { status?: number; message?: string; response?: { headers?: Record<string, string | undefined> } };
  if (e.status !== 403 && e.status !== 429) return undefined;
  const headers = e.response?.headers ?? {};
  const exhausted = headers['x-ratelimit-remaining'] === '0';
  if (!exhausted && !/rate limit/i.test(e.message ?? '')) return undefined;
  const resetSeconds = Number(headers['x-ratelimit-reset']);
  const retryAfterSeconds = Number(headers['retry-after']);
  const resetAt = Number.isFinite(resetSeconds) && resetSeconds > 0
    ? resetSeconds * 1000
    : Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0 ? now + retryAfterSeconds * 1000 : undefined;
  const when = resetAt === undefined
    ? 'Try again in a few minutes.'
    : `It resets at ${new Date(resetAt).toISOString().slice(11, 16)} UTC, in about ${Math.max(1, Math.ceil((resetAt - now) / 60_000))} min. Try again after that.`;
  return `${operation}: GitHub's rate limit for this account is used up. ${when}`;
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
