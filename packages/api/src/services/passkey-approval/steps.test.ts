import { describe, expect, it } from "vitest";
import { planCommitChain } from "@valet/plugin-turnkey/commits";
import { EMAIL, PUBLIC_HEX, UNSIGNED_1, UNSIGNED_1_SHA, UNSIGNED_2, UNSIGNED_2_SHA, signWithTestKey } from "@valet/plugin-turnkey/test-helpers/commit-fixtures";
import type { TurnkeyActivity } from "@valet/plugin-turnkey/turnkey-client";
import {
  challengePayload,
  nextPresenceStep,
  stepBody,
  submittedBodyRefusal,
  verifiedSignature,
  type PresenceGateLike,
  type PresenceSigner,
} from "./steps.js";

const NOW = 1_800_000_000_000;
const signer: PresenceSigner = { organizationId: "sub-1", privateKeyId: "pk-1", publicKeyHex: PUBLIC_HEX, passkeyUserId: "passkey-user" };
const signing = {
  commits: [{ sha: UNSIGNED_1_SHA, object: UNSIGNED_1 }, { sha: UNSIGNED_2_SHA, object: UNSIGNED_2 }],
  committerEmail: EMAIL,
  publicKeyHex: PUBLIC_HEX,
  privateKeyId: "pk-1",
  subOrgId: "sub-1",
  passkeyUserId: "passkey-user",
};
const commitsGate: PresenceGateLike = {
  id: "g1",
  sessionId: "s1",
  title: "Sign 2 commits",
  context: { assurance: "presence", presence: { kind: "git_commits" }, signing },
};
const plainGate: PresenceGateLike = { id: "g2", sessionId: "s1", title: "Deploy?", body: "to prod", context: { assurance: "presence" } };

function activity(payloadHex: string, overrides: Partial<TurnkeyActivity> = {}): TurnkeyActivity {
  const sig = signWithTestKey(Buffer.from(payloadHex, "hex")).toString("hex");
  return {
    id: "act-1",
    organizationId: "sub-1",
    status: "ACTIVITY_STATUS_COMPLETED",
    type: "ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2",
    votes: [{ userId: "passkey-user", selection: "VOTE_SELECTION_APPROVED" }],
    result: { signRawPayloadResult: { r: sig.slice(0, 64), s: sig.slice(64) } },
    ...overrides,
  };
}

describe("nextPresenceStep", () => {
  it("walks a commit chain one signature at a time", () => {
    const first = nextPresenceStep(commitsGate, []);
    expect(first).toMatchObject({ index: 0, total: 2, label: "Commit 1 of 2: first commit" });
    const plan = planCommitChain({ ...signing, signatures: [] });
    expect(first?.payloadHex).toBe(plan.nextPayload?.toString("hex"));
    const sig1 = signWithTestKey(Buffer.from(first!.payloadHex, "hex"));
    expect(nextPresenceStep(commitsGate, [sig1])).toMatchObject({ index: 1, label: "Commit 2 of 2: second commit" });
    const second = nextPresenceStep(commitsGate, [sig1])!;
    expect(nextPresenceStep(commitsGate, [sig1, signWithTestKey(Buffer.from(second.payloadHex, "hex"))])).toBeNull();
  });

  it("gives a plain presence gate one challenge step that names the gate", () => {
    expect(nextPresenceStep(plainGate, [])).toEqual({ index: 0, total: 1, label: "Deploy?", payloadHex: challengePayload(plainGate).toString("hex") });
    expect(challengePayload(plainGate)).not.toEqual(challengePayload({ ...plainGate, id: "other" }));
    expect(nextPresenceStep(plainGate, [Buffer.alloc(64)])).toBeNull();
  });
});

describe("submittedBodyRefusal", () => {
  const step = nextPresenceStep(plainGate, [])!;

  it("accepts the issued body", () => {
    expect(submittedBodyRefusal(stepBody(step, signer, NOW), step, signer, NOW + 1000)).toBeNull();
  });

  it("refuses another step's payload, another key, and an old timestamp", () => {
    const other = { ...step, payloadHex: "00".repeat(32) };
    expect(submittedBodyRefusal(stepBody(other, signer, NOW), step, signer, NOW)).toContain("not the step");
    expect(submittedBodyRefusal(stepBody(step, { ...signer, privateKeyId: "pk-2" }, NOW), step, signer, NOW)).toContain("not the step");
    expect(submittedBodyRefusal(stepBody(step, signer, NOW - 6 * 60_000), step, signer, NOW)).toContain("too old");
    expect(submittedBodyRefusal("nope", step, signer, NOW)).toContain("not JSON");
  });
});

describe("verifiedSignature", () => {
  const step = nextPresenceStep(plainGate, [])!;

  it("returns the signature when the passkey user approved and it verifies", () => {
    const sig = verifiedSignature(activity(step.payloadHex), step, signer);
    expect(Buffer.isBuffer(sig) && sig.length).toBe(64);
  });

  it("refuses a missing passkey vote, a wrong organization, a pending activity, and a signature over other bytes", () => {
    expect(verifiedSignature(activity(step.payloadHex, { votes: [{ userId: "agent", selection: "VOTE_SELECTION_APPROVED" }] }), step, signer)).toContain("passkey");
    expect(verifiedSignature(activity(step.payloadHex, { organizationId: "sub-2" }), step, signer)).toContain("another organization");
    expect(verifiedSignature(activity(step.payloadHex, { status: "ACTIVITY_STATUS_PENDING" }), step, signer)).toContain("did not complete");
    expect(verifiedSignature(activity("11".repeat(32)), step, signer)).toContain("does not match");
  });
});
