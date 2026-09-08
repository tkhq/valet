import { resolveGitHubToken, type GitHubTokenDeps, type GitHubAuthMode, type ResolvedGitHubToken } from "./github-tokens.js";
import { GitHubSkillRepoReader, SkillRepoNotFoundError } from "./skill-repo-reader.js";

export type RepoExistence =
  | { kind: "found"; fullName: string; cloneUrl: string }
  | { kind: "not-found"; error: string }
  | { kind: "unverified" };

type RepoCheckRequest = { orgId: string; userId?: string; host: string; fullName: string; auth?: GitHubAuthMode; allowAnonymous?: boolean };

/** Bound the whole check, including credential discovery and token refresh. */
export async function checkRepoExistence(deps: GitHubTokenDeps, request: RepoCheckRequest): Promise<RepoExistence> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const deadline = new Promise<RepoExistence>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      console.warn(`Repository check skipped for ${request.fullName}: check timed out`);
      resolve({ kind: "unverified" });
    }, 5_000);
  });
  try {
    return await Promise.race([verifyRepoExistence(deps, request, controller.signal), deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/** Only a repository metadata 404 proves that this credential cannot read the repository. */
async function verifyRepoExistence(
  deps: GitHubTokenDeps,
  request: RepoCheckRequest,
  signal: AbortSignal,
): Promise<RepoExistence> {
  const unverified = (reason: string): RepoExistence => {
    console.warn(`Repository check skipped for ${request.fullName}: ${reason}`);
    return { kind: "unverified" };
  };
  if (request.host !== "github") return unverified("unsupported host");
  const parts = request.fullName.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return unverified("invalid repository name");

  let credential: ResolvedGitHubToken;
  try {
    const tokenRequest = {
      orgId: request.orgId, userId: request.userId, auth: request.auth,
      repo: { owner: parts[0], name: parts[1] },
    };
    credential = await resolveGitHubToken(deps, { ...tokenRequest, purpose: "git" });
    if (!credential.token && request.allowAnonymous === false) return unverified("anonymous image bakes are disabled");
    // A sole installation can check an org typo even when cloning would be anonymous.
    if (!credential.token && !signal.aborted) {
      credential = await resolveGitHubToken(deps, { ...tokenRequest, purpose: "api" });
    }
  } catch {
    if (request.auth && request.auth !== "auto") return unverified("credential unavailable");
    credential = { token: null, source: "none" };
  }
  // Token refresh can be shared with other callers. Let it finish after our deadline.
  if (signal.aborted) return { kind: "unverified" };
  if (!credential.token && request.allowAnonymous === false) return unverified("anonymous image bakes are disabled");

  const reader = new GitHubSkillRepoReader({
    apiUrl: deps.apiUrl, fetchImpl: deps.fetchImpl, timeoutMs: 5_000,
    credential: !credential.token ? { kind: "none" }
      : credential.source === "installation"
        ? { kind: "installation", token: credential.token }
        : { kind: "user", token: credential.token, ownerScope: "user" },
  });
  try {
    return { kind: "found", ...await reader.repository(request.fullName) };
  } catch (error) {
    if (error instanceof SkillRepoNotFoundError) {
      if (!credential.token) return unverified("repository is not public or was not found");
      return {
        kind: "not-found",
        error: `Repository "${request.fullName}" was not found. Check the organization name or connect a GitHub account with access in Settings.`,
      };
    }
    return unverified("GitHub request failed");
  }
}
