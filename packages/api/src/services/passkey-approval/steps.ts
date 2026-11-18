/**
 * Passkey approval steps
 * (`docs/specs/2026-11-17-commit-signing-user-registered-keys-design.md`).
 *
 * Every step is one `SIGN_RAW_PAYLOAD_V2` activity in the approver's own
 * Turnkey sub-organization, signed with their signing key and stamped by
 * their passkey in the browser. The api issues the unsigned body, checks
 * that the stamped body is the one it issued, forwards it to Turnkey
 * unchanged, and checks the completed activity. Turnkey verifies the
 * passkey; the api never does.
 *
 * - A `git_commits` gate (`turnkey.sign_commits`) has one step per commit.
 * - Any other gate with `context.assurance = "presence"` has one step: a
 *   signature over a challenge that names the gate.
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { planCommitChain } from "@valet/plugin-turnkey/commits";
import { GIT_COMMITS_KIND, signingContextOf } from "@valet/plugin-turnkey/presence";
import type { TurnkeyActivity } from "@valet/plugin-turnkey/turnkey-client";

export const STEP_MAX_AGE_MS = 5 * 60_000;
const STEP_MAX_SKEW_MS = 60_000;
export const SIGN_ACTIVITY = "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2";

/** Whose key signs, and who must approve. */
export interface PresenceSigner {
  organizationId: string;
  privateKeyId: string;
  publicKeyHex: string;
  passkeyUserId: string;
}

export interface PresenceGateLike {
  id: string;
  sessionId: string;
  title: string;
  body?: string;
  context?: Record<string, unknown>;
}

export interface PresenceStep {
  index: number;
  total: number;
  label: string;
  payloadHex: string;
}

/** The challenge a plain presence gate signs: it names the session, the gate, and what the card showed. */
export function challengePayload(gate: PresenceGateLike): Buffer {
  return createHash("sha256")
    .update(["valet-approval", gate.sessionId, gate.id, gate.title, gate.body ?? ""].join("\n"), "utf8")
    .digest();
}

/** The next step, or null when every step has a signature. */
export function nextPresenceStep(gate: PresenceGateLike, signatures: Uint8Array[]): PresenceStep | null {
  const signing = signingContextOf(gate.context);
  const presence = gate.context?.presence;
  const kind = typeof presence === "object" && presence !== null && "kind" in presence ? presence.kind : undefined;
  if (kind === GIT_COMMITS_KIND && signing) {
    const plan = planCommitChain({ ...signing, signatures });
    if (!plan.nextPayload) return null;
    const total = signing.commits.length;
    const index = plan.rewritten.length;
    return { index, total, label: `Commit ${index + 1} of ${total}: ${plan.nextSubject ?? ""}`.trim(), payloadHex: plan.nextPayload.toString("hex") };
  }
  if (signatures.length > 0) return null;
  return { index: 0, total: 1, label: gate.title, payloadHex: challengePayload(gate).toString("hex") };
}

/** The unsigned Turnkey request body the browser stamps. */
export function stepBody(step: PresenceStep, signer: PresenceSigner, now: number): string {
  return JSON.stringify({
    type: SIGN_ACTIVITY,
    timestampMs: String(now),
    organizationId: signer.organizationId,
    parameters: {
      signWith: signer.privateKeyId,
      payload: step.payloadHex,
      encoding: "PAYLOAD_ENCODING_HEXADECIMAL",
      hashFunction: "HASH_FUNCTION_NOT_APPLICABLE",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Why a submitted body is not the expected step, or null when it is. Checked before anything goes to Turnkey. */
export function submittedBodyRefusal(body: string, step: PresenceStep, signer: PresenceSigner, now: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "The signed request is not JSON. Sign again from the card.";
  }
  if (!isRecord(parsed) || !isRecord(parsed.parameters)) return "The signed request has the wrong shape. Sign again from the card.";
  const p = parsed.parameters;
  if (
    parsed.type !== SIGN_ACTIVITY ||
    parsed.organizationId !== signer.organizationId ||
    p.signWith !== signer.privateKeyId ||
    p.payload !== step.payloadHex ||
    p.encoding !== "PAYLOAD_ENCODING_HEXADECIMAL" ||
    p.hashFunction !== "HASH_FUNCTION_NOT_APPLICABLE"
  ) {
    return "The signed request is not the step this approval is waiting for. Reload the thread and sign again.";
  }
  const ts = typeof parsed.timestampMs === "string" ? Number(parsed.timestampMs) : NaN;
  if (!Number.isFinite(ts) || ts < now - STEP_MAX_AGE_MS || ts > now + STEP_MAX_SKEW_MS) {
    return "The signed request is too old. Sign again from the card.";
  }
  return null;
}

const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

/** One verified passkey tap: the AuthZEN proof's `activities` entry plus the signature and the vote's authenticator. */
export interface VerifiedTap {
  signature: Buffer;
  activityId: string;
  payloadSha256: string;
  approvedAtMs: number;
  authenticator?: { scheme: string; public_key: string };
}

/** The verified tap from a completed activity, after checking it is the passkey's signature over `payloadHex`. */
export function verifiedTap(activity: TurnkeyActivity, step: PresenceStep, signer: PresenceSigner, now: number): VerifiedTap | string {
  const signature = verifiedSignature(activity, step, signer);
  if (typeof signature === "string") return signature;
  const vote = activity.votes.find((v) => v.userId === signer.passkeyUserId && v.selection === "VOTE_SELECTION_APPROVED");
  return {
    signature,
    activityId: activity.id,
    payloadSha256: createHash("sha256").update(Buffer.from(step.payloadHex, "hex")).digest("hex"),
    approvedAtMs: vote?.createdAtMs ?? now,
    ...(vote?.scheme && vote.publicKey ? { authenticator: { scheme: vote.scheme, public_key: vote.publicKey } } : {}),
  };
}

/** The 64-byte signature from a completed activity, after checking it is the passkey's signature over `payloadHex`. */
export function verifiedSignature(activity: TurnkeyActivity, step: PresenceStep, signer: PresenceSigner): Buffer | string {
  if (activity.type !== SIGN_ACTIVITY) return `Turnkey ran ${activity.type}, not a signature. Sign again from the card.`;
  if (activity.organizationId !== signer.organizationId) return "Turnkey signed in another organization. Sign again from the card.";
  if (activity.status !== "ACTIVITY_STATUS_COMPLETED") return `Turnkey did not complete the signature (${activity.status}). Sign again from the card.`;
  if (!activity.votes.some((v) => v.userId === signer.passkeyUserId && v.selection === "VOTE_SELECTION_APPROVED")) {
    return "Turnkey did not record your passkey's approval on this signature. Sign again with the passkey you set up in Settings.";
  }
  const sig = activity.result?.signRawPayloadResult;
  if (!sig) return "Turnkey returned no signature. Sign again from the card.";
  const signature = Buffer.from(sig.r + sig.s, "hex");
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, Buffer.from(signer.publicKeyHex, "hex")]), format: "der", type: "spki" });
  if (signature.length !== 64 || !verify(null, Buffer.from(step.payloadHex, "hex"), key, signature)) {
    return "The signature does not match your signing key. Sign again from the card.";
  }
  return signature;
}
