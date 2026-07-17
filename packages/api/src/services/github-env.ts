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
