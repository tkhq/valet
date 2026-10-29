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
 * GitHub sends no reset time for a secondary rate limit and asks clients to
 * wait at least 60s, so a shorter cap fails every secondary limit at once.
 * A primary limit usually resets much later, up to an hour, so it fails at
 * once and `rateLimitError` names the reset time.
 */
export const MAX_RATE_LIMIT_WAIT_SECONDS = 60;

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function waitUnlessAborted(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The throttle handler: retry once when the wait is short enough, and do
 * the wait here so Stop can end it. Octokit's own retry delay is set to
 * zero (`retryAfterBaseValue: 0`) because this handler already waited.
 */
function waitThenRetry(signal: AbortSignal | undefined) {
  return (retryAfter: number, options: { request: { retryCount: number } }): Promise<boolean> | boolean => {
    if (options.request.retryCount > 0 || retryAfter > MAX_RATE_LIMIT_WAIT_SECONDS) return false;
    return waitUnlessAborted(retryAfter * 1000, signal);
  };
}

/**
 * The one Octokit constructor for this package. `signal` is the action's
 * abort signal: every request and every rate-limit wait ends when it aborts.
 * Octokit's default handlers slept until the quota reset and ignored the
 * signal, so a turn waiting there could not be stopped.
 */
export function githubOctokit(token: string, signal?: AbortSignal): Octokit {
  const onLimit = waitThenRetry(signal);
  return new Octokit({
    auth: token,
    baseUrl: resolveGithubApiUrl(),
    ...(signal ? { request: { signal } } : {}),
    throttle: { onRateLimit: onLimit, onSecondaryRateLimit: onLimit, retryAfterBaseValue: 0 },
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
