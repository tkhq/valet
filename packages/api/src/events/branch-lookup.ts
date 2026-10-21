import { eq } from "drizzle-orm";
import type { EventMatchDigest, Wakeup } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions } from "../schema/index.js";
import type { GitHubTokenDeps } from "../services/github-tokens.js";
import { githubInstallationTokenFor } from "./derive.js";

export interface BranchLookupResult {
  pullRequest: string | null;
  failed: boolean;
  closed?: EventMatchDigest;
}
export type BranchLookup = (row: Wakeup) => Promise<BranchLookupResult>;

/** Bounded lookup with the installation authorized at arm. No turn credential closure survives a restart. */
export function productionBranchLookup(deps: { db: AppDb; githubTokenDeps: GitHubTokenDeps }): BranchLookup {
  const tokenFor = githubInstallationTokenFor(deps.githubTokenDeps);
  return async (row) => {
    const branch = /^github:([^/]+)\/([^:]+):branch\/(.+)$/.exec(row.eventMatch?.primarySubject ?? "");
    if (!branch) return { pullRequest: null, failed: false };
    const owner = branch[1]!;
    const [session] = await deps.db.select({ orgId: agentSessions.orgId, status: agentSessions.status })
      .from(agentSessions).where(eq(agentSessions.id, row.sessionId)).limit(1);
    if (!session || session.status === "deleted") return { pullRequest: null, failed: true };
    const token = await tokenFor(session.orgId, owner);
    if (!token) return { pullRequest: null, failed: true };
    const base = deps.githubTokenDeps.apiUrl ?? "https://api.github.com";
    const read = async (path: string): Promise<unknown> => {
      const response = await (deps.githubTokenDeps.fetchImpl ?? fetch)(`${base}${path}`, { signal: AbortSignal.timeout(5000),
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "valet" } });
      if (!response.ok) throw new Error("GitHub branch lookup failed. Check the installation's repository access.");
      return response.json();
    };
    return findOpenBranchPullRequest(row, read);
  };
}

/** Verify both the list candidate and its fresh PR head before binding. */
export async function findOpenBranchPullRequest(row: Wakeup, read: (path: string) => Promise<unknown>): Promise<BranchLookupResult> {
  const primary = row.eventMatch?.primarySubject;
  const branch = /^github:([^/]+)\/([^:]+):branch\/(.+)$/.exec(primary ?? "");
  if (!branch || !primary) return { pullRequest: null, failed: false };
  const owner = branch[1]!;
  const repo = branch[2]!;
  const ref = branch[3]!;
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`;
  const body = await read(`${path}?${new URLSearchParams({ state: "open", head: `${owner}:${ref}`, per_page: "100" })}`);
  if (!Array.isArray(body)) throw new Error("GitHub returned an invalid PR list. Retry the branch lookup.");
  const record = (v: unknown): Record<string, unknown> | undefined => typeof v === "object" && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
  for (const item of body) {
    const pull = record(item);
    const head = record(pull?.head);
    if (head?.ref !== ref || record(head.repo)?.full_name !== `${owner}/${repo}` || typeof pull?.number !== "number") continue;
    const subject = `github:${owner}/${repo}#${pull.number}`;
    // The list can race a merge. Validate again before binding.
    const current = record(await read(`${path}/${pull.number}`));
    const currentHead = record(current?.head);
    if (currentHead?.ref !== ref || record(currentHead.repo)?.full_name !== `${owner}/${repo}`) continue;
    if (current?.state === "open") return { pullRequest: subject, failed: false };
    if (current?.state !== "closed") return { pullRequest: null, failed: true };
    const status = current.merged === true ? "merged" : "closed";
    return { pullRequest: null, failed: false, closed: { key: "github.pull_request.closed", status, branchClosed: true,
      subjects: [primary, subject], dedupeKey: `lookup-close:${subject}:${status}`, occurredAt: new Date().toISOString(),
      summary: `The PR was ${status}. This branch wait stays armed for another PR.`,
      ...(status === "merged" && typeof current.merge_commit_sha === "string" ? { merge_commit_sha: current.merge_commit_sha } : {}),
    } };
  }
  return { pullRequest: null, failed: false };
}
