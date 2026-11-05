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
      "The key is deleted after the window or when the pull request closes.",
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

/** The title shown next to the key in the user's GitHub settings. */
export function githubKeyTitle(sessionId: string, scope: SigningScope, notAfter: Date): string {
  const pr = scope.prNumber === undefined ? "" : `#${scope.prNumber}`;
  return `valet session ${sessionId} ${scope.repo}${pr} until ${notAfter.toISOString()}`;
}

/** The Turnkey private key name; one key per approval. */
export function signingKeyName(sessionId: string, scope: SigningScope): string {
  const pr = scope.prNumber === undefined ? "" : `#${scope.prNumber}`;
  return `valet ${scope.repo}${pr} ${sessionId}`.slice(0, 120);
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
