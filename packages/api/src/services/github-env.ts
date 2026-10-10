/**
 * GitHub base-URL resolution (GitHub/repo integration plan, Task 3).
 * Mirrors `providers/sandbox-backend.ts`'s `resolveDefaultImage` pattern:
 * a pure `env -> value` function with a hardcoded default, so tests can
 * point the github-app service at a fixture server without touching global
 * state.
 */
export function resolveGithubApiUrl(env: NodeJS.ProcessEnv): string {
  return env.GITHUB_API_URL || "https://api.github.com";
}

export function resolveGithubUrl(env: NodeJS.ProcessEnv): string {
  return env.GITHUB_URL || "https://github.com";
}

/** A GitHub API base URL, compared as a host key. A GitHub account id is
 * unique only on one host: the same number on GitHub Enterprise Server names
 * somebody else. */
export function githubHostKey(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, "").toLowerCase();
}

/** Builds the account-selection URL for a GitHub App installation. */
export function githubAppInstallUrl(env: NodeJS.ProcessEnv, appSlug: string): string {
  return `${resolveGithubUrl(env)}/apps/${appSlug}/installations/new`;
}
