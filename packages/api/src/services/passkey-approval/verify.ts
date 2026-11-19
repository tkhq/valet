/**
 * Re-checks a passkey approval before a `presence` gate accepts it
 * (`docs/specs/2026-11-17-commit-signing-user-registered-keys-design.md`).
 *
 * The approval record says which Turnkey activities the passkey stamped.
 * This verifier trusts none of it: it reads every activity back from
 * Turnkey, rebuilds the payload each step had to cover from the gate itself,
 * and checks the passkey vote and the signature. A record written by any
 * path other than a real passkey tap fails here. It does not defend against
 * a fully compromised api, which could also replace this code.
 */
import type { DecisionGate, DecisionResolution } from "@valet/engine";
import { signingContextOf } from "@valet/plugin-turnkey/presence";
import { COLLECTIONS, DEFAULT_KEY, PLUGIN_NAME, type EnrollmentDoc } from "@valet/plugin-turnkey/store";
import type { TurnkeyActivity, TurnkeyOps } from "@valet/plugin-turnkey/turnkey-client";
import type { AppQueryable } from "../../lib/drizzle.js";
import { pluginStore } from "../plugin-store.js";
import { presenceDeps } from "./deps.js";
import { approvedVote, nextPresenceStep, verifiedTap, type PresenceSigner } from "./steps.js";

/** Who had to sign: from the gate for commit signing, else the approver's enrollment. */
async function expectedSigner(db: AppQueryable, gate: DecisionGate, resolution: DecisionResolution): Promise<PresenceSigner | null> {
  const signing = signingContextOf(gate.context);
  if (signing) {
    return { organizationId: signing.subOrgId, privateKeyId: signing.privateKeyId, publicKeyHex: signing.publicKeyHex, passkeyUserId: signing.passkeyUserId };
  }
  const enrollment = (await pluginStore(db, PLUGIN_NAME).user(resolution.resolvedBy).get<EnrollmentDoc>(COLLECTIONS.enrollment, DEFAULT_KEY))?.doc;
  if (!enrollment?.signingKey) return null;
  return {
    organizationId: enrollment.subOrgId,
    privateKeyId: enrollment.signingKey.privateKeyId,
    publicKeyHex: enrollment.signingKey.publicKeyHex,
    passkeyUserId: enrollment.passkeyUserId,
  };
}

/** Waits between reads of a completed activity that does not show the passkey's vote yet: five reads in about 4 seconds. */
export const VOTE_READ_DELAYS_MS = [250, 500, 1000, 2000];

/**
 * Reads the activity back from Turnkey. A read right after the passkey tap
 * can show the activity COMPLETED before it shows the passkey's vote, so a
 * completed activity with no vote from the signer is read again a few times.
 * If the vote does not show, the check that follows refuses the approval.
 */
async function readBack(ops: Pick<TurnkeyOps, "getActivity">, signer: PresenceSigner, activityId: string): Promise<TurnkeyActivity | null> {
  const read = () => ops.getActivity({ subOrgId: signer.organizationId, activityId }).catch(() => null);
  let activity = await read();
  for (const delay of VOTE_READ_DELAYS_MS) {
    if (!activity || activity.status !== "ACTIVITY_STATUS_COMPLETED" || approvedVote(activity, signer.passkeyUserId)) break;
    await presenceDeps.sleep(delay);
    activity = (await read()) ?? activity;
  }
  return activity;
}

export function presenceApprovalVerifier(db: AppQueryable) {
  return async (gate: DecisionGate, resolution: DecisionResolution): Promise<string | null> => {
    const proof = resolution.approval?.state;
    if (!proof) return "The approval has no proof of presence. Approve it with your passkey in Valet.";
    const config = presenceDeps.config();
    if (!config) return "Passkey approvals need Turnkey. Ask an admin to set the VALET_TURNKEY_* variables.";
    const signer = await expectedSigner(db, gate, resolution);
    if (!signer) return "The approver has no passkey signing setup. Set it up in Settings, Commit signing.";
    if (proof.organization_id !== signer.organizationId || proof.approver.user_id !== signer.passkeyUserId) {
      return "The proof names a different passkey than this approval needs. Approve it again with your own passkey.";
    }
    const ops = presenceDeps.turnkey(config);
    const signatures: Buffer[] = [];
    for (const entry of proof.activities) {
      const step = nextPresenceStep(gate, signatures);
      if (!step) return "The proof lists more passkey taps than this approval has steps.";
      const activity = await readBack(ops, signer, entry.activity_id);
      if (!activity) return `Turnkey has no activity ${entry.activity_id}. Approve it again with your passkey.`;
      const tap = verifiedTap(activity, step, signer, presenceDeps.now());
      if (typeof tap === "string") return tap;
      if (tap.payloadSha256 !== entry.payload_sha256) return "The proof's payload digest does not match what the passkey signed.";
      signatures.push(tap.signature);
    }
    if (nextPresenceStep(gate, signatures)) return "The proof does not cover every step of this approval. Finish signing in Valet.";
    return null;
  };
}
