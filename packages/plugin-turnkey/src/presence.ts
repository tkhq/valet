/**
 * What a passkey-signing gate carries, shared by `turnkey.sign_commits`
 * (which opens the gate and writes the signed commits) and the api's
 * passkey endpoint (which collects one signature per step).
 */
import type { SourceCommit } from "./commits.js";

export const GIT_COMMITS_KIND = "git_commits";

/** Stored at `context.signing` on a `git_commits` gate. Never sent to the browser. */
export interface GitCommitsSigningContext {
  commits: SourceCommit[];
  committerEmail: string;
  publicKeyHex: string;
  privateKeyId: string;
  subOrgId: string;
  passkeyUserId: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function signingContextOf(context: Record<string, unknown> | undefined): GitCommitsSigningContext | undefined {
  const raw = context?.signing;
  if (!isRecord(raw)) return undefined;
  const { committerEmail, publicKeyHex, privateKeyId, subOrgId, passkeyUserId, commits } = raw;
  if (
    typeof committerEmail !== "string" ||
    typeof publicKeyHex !== "string" ||
    typeof privateKeyId !== "string" ||
    typeof subOrgId !== "string" ||
    typeof passkeyUserId !== "string" ||
    !Array.isArray(commits)
  ) {
    return undefined;
  }
  const parsed: SourceCommit[] = [];
  for (const c of commits) {
    if (!isRecord(c) || typeof c.sha !== "string" || typeof c.object !== "string") return undefined;
    parsed.push({ sha: c.sha, object: c.object });
  }
  return { commits: parsed, committerEmail, publicKeyHex, privateKeyId, subOrgId, passkeyUserId };
}

/**
 * Plugin-store key (scope `session`, collection `presence_steps`) for one
 * gate's collected signatures. The resume key plus the gate's ordinal: a
 * retried call after a terminal decision gets a new ordinal, so it never
 * reuses an older gate's signatures.
 */
export function presenceStepsKey(resumeKey: string, ordinal: number): string {
  return `${resumeKey}#${ordinal}`;
}
