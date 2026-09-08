import { resolveGitHubToken, type GitHubTokenDeps, type GitHubAuthMode, type ResolvedGitHubToken } from "./github-tokens.js";
import { GitHubSkillRepoReader, SkillRepoNotFoundError } from "./skill-repo-reader.js";

export type RepoExistence =
  | { kind: "found"; fullName: string; cloneUrl: string }
  | { kind: "not-found"; error: string }
  | { kind: "unverified" };

/** Only a repository metadata 404 proves that this credential cannot read the repository. */
export async function checkRepoExistence(
  deps: GitHubTokenDeps,
  request: { orgId: string; userId?: string; host: string; fullName: string; auth?: GitHubAuthMode },
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
    credential = await resolveGitHubToken(deps, {
      orgId: request.orgId, userId: request.userId, auth: request.auth,
      purpose: "api", repo: { owner: parts[0], name: parts[1] },
    });
  } catch {
    return unverified("credential unavailable");
  }
  if (!credential.token) return unverified("no credential");

  const reader = new GitHubSkillRepoReader({
    apiUrl: deps.apiUrl, fetchImpl: deps.fetchImpl, timeoutMs: 5_000,
    credential: credential.source === "installation"
      ? { kind: "installation", token: credential.token }
      : { kind: "user", token: credential.token, ownerScope: "user" },
  });
  try {
    return { kind: "found", ...await reader.repository(request.fullName) };
  } catch (error) {
    if (error instanceof SkillRepoNotFoundError) {
      return {
        kind: "not-found",
        error: `Repository "${request.fullName}" was not found. Check the organization name or connect a GitHub account with access in Settings.`,
      };
    }
    return unverified("GitHub request failed");
  }
}
