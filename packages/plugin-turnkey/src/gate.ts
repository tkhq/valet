/**
 * The approval scope for one signing key, and the text that describes it.
 *
 * The gate body is the one thing a person reads before a key is issued, so
 * it is built here, tested for exact wording, and never abbreviated.
 */
import type { DecisionGateRequest } from "@valet/engine";

export const DEFAULT_WINDOW_MINUTES = 120;
export const MAX_WINDOW_MINUTES = 24 * 60;

export interface SigningScope {
  /** `owner/name`. */
  repo: string;
  branch: string;
  prNumber?: number;
  windowMinutes: number;
}

/** Clamps a requested window to [1, MAX_WINDOW_MINUTES]; absent means the default. */
export function clampWindowMinutes(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_WINDOW_MINUTES;
  return Math.min(MAX_WINDOW_MINUTES, Math.max(1, Math.floor(requested)));
}

/** `120` -> `2 h`, `90` -> `1 h 30 min`, `45` -> `45 min`. */
export function formatWindow(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m} min`;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}

export function signingGateResumeKey(scope: Pick<SigningScope, "repo" | "branch">): string {
  return `signing-key:${scope.repo}:${scope.branch}`;
}

export function signingGateRequest(scope: SigningScope): DecisionGateRequest {
  const pr = scope.prNumber === undefined ? "" : ` (pull request #${scope.prNumber})`;
  return {
    type: "credential_request",
    title: "Sign commits",
    body:
      `Sign commits in ${scope.repo}, branch ${scope.branch}${pr}, valid for ${formatWindow(scope.windowMinutes)}?\n` +
      "Git in the sandbox can sign any commit until the window ends.",
    actions: [
      { id: "approve", label: "Approve", style: "primary", approves: true },
      { id: "reject", label: "Reject", style: "danger" },
    ],
    resumeKey: signingGateResumeKey(scope),
    context: {
      repo: scope.repo,
      branch: scope.branch,
      ...(scope.prNumber === undefined ? {} : { prNumber: scope.prNumber }),
      windowMinutes: scope.windowMinutes,
    },
  };
}

/**
 * The passkey gate for `turnkey.sign_commits`. Each approving step is a
 * passkey-stamped Turnkey signature, so the approve action is marked
 * `approves` and the engine refuses it without presence evidence.
 */
export function commitSigningGateRequest(args: {
  repo: string;
  branch: string;
  headSha: string;
  commits: Array<{ sha: string }>;
  context: Record<string, unknown>;
}): DecisionGateRequest {
  const n = args.commits.length;
  return {
    type: "credential_request",
    title: n === 1 ? "Sign 1 commit" : `Sign ${n} commits`,
    body:
      `Sign ${n === 1 ? "this commit" : `these ${n} commits`} in ${args.repo}, branch ${args.branch}, with your passkey?\n` +
      `Your passkey asks once per commit.`,
    actions: [
      { id: "approve", label: "Sign with passkey", style: "primary", approves: true },
      { id: "reject", label: "Reject", style: "danger" },
    ],
    resumeKey: `sign-commits:${args.repo}:${args.branch}:${args.headSha}`,
    // A rejection answers every later request for this branch in the same
    // turn, so a looping agent cannot keep asking for taps.
    dedupeKey: `sign-commits:${args.repo}:${args.branch}`,
    context: args.context,
  };
}

/**
 * The one allow policy in a user's sub-organization. Non-root users are
 * denied by default, so this is the whole authority of `valet-agent`: sign
 * raw payloads with a key that carries the `agent-signing` tag. Tag IDs,
 * not names, go in the text.
 */
export function agentSigningPolicy(agentTagId: string, signingTagId: string): {
  policyName: string;
  effect: "EFFECT_ALLOW";
  condition: string;
  consensus: string;
  notes: string;
} {
  return {
    policyName: "valet-agent: sign with agent-signing keys",
    effect: "EFFECT_ALLOW",
    condition: `activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && private_key.tags.contains('${signingTagId}')`,
    consensus: `approvers.any(user, user.tags.contains('${agentTagId}'))`,
    notes: "Valet commit signing. The session API key on valet-agent expires with the session.",
  };
}

/**
 * The parent key's standing grant in a session-mode sub-organization.
 * Enrollment takes the parent key out of the root quorum, so without this
 * policy it could not create the window's session API key. The condition
 * names `valet-agent` through `activity.params.user_id`, so the grant cannot
 * add a credential to the passkey user or any other user. It cannot create
 * keys, sign, export, or change users, tags, or policies. Presence-mode
 * sub-organizations get no parent grant at all.
 */
export function parentKeyPolicy(parentUserId: string, agentUserId: string): {
  policyName: string;
  effect: "EFFECT_ALLOW";
  condition: string;
  consensus: string;
  notes: string;
} {
  return {
    policyName: "valet-parent: session keys for valet-agent",
    effect: "EFFECT_ALLOW",
    condition:
      "activity.type in ['ACTIVITY_TYPE_CREATE_API_KEYS_V2', 'ACTIVITY_TYPE_DELETE_API_KEYS'] && " +
      `activity.params.user_id == '${agentUserId}'`,
    consensus: `approvers.any(user, user.id == '${parentUserId}')`,
    notes: "Valet commit signing, session mode. Creates and deletes the expiring session API key on valet-agent.",
  };
}
