import type { Octokit } from "octokit";

/** The most commits GitHub's compare endpoint lists in one response. */
const COMPARE_COMMIT_LIMIT = 250;

/**
 * Checks the commits a pull request would carry against the organization's
 * signed pull request rule (`ToolContext.pullRequestRequirement`). Returns
 * the refusal when GitHub does not show every commit from `base` to `head`
 * as Verified, and undefined when all are Verified. `requirement` is the
 * host's instruction for the model, appended to the refusal.
 */
export async function unsignedCommitsRefusal(
  octokit: Octokit,
  pr: { owner: string; repo: string; base: string; head: string },
  requirement: string,
): Promise<string | undefined> {
  const { data } = await octokit.request("GET /repos/{owner}/{repo}/compare/{basehead}", {
    owner: pr.owner,
    repo: pr.repo,
    basehead: `${pr.base}...${pr.head}`,
    per_page: COMPARE_COMMIT_LIMIT,
  });
  if (data.total_commits > data.commits.length) {
    return `Pull request not opened. ${pr.head} has ${data.total_commits} commits, more than Valet can check (${COMPARE_COMMIT_LIMIT}). Squash the branch. ${requirement}`;
  }
  const unsigned = data.commits.filter((c) => c.commit.verification?.verified !== true).map((c) => c.sha.slice(0, 7));
  if (unsigned.length === 0) return undefined;
  return `Pull request not opened. ${unsigned.length} of ${data.commits.length} commits on ${pr.head} are not Verified on GitHub: ${unsigned.join(", ")}. ${requirement}`;
}
