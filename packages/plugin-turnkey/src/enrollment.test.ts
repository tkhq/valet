import { describe, expect, it } from "vitest";
import type { TurnkeyDeploymentConfig } from "./config.js";
import { enrollUser } from "./enrollment.js";
import { EXPECTED_FINGERPRINT, EXPECTED_LINE, RAW_ED25519_HEX, fakeTurnkey } from "./test-helpers/fakes.js";

const CONFIG: TurnkeyDeploymentConfig = {
  organizationId: "parent",
  apiPublicKey: "02aa",
  apiPrivateKey: "bb",
  apiBaseUrl: "https://api",
  assurance: "presence",
};
const PASSKEY = {
  authenticatorName: "passkey",
  challenge: "c",
  attestation: { credentialId: "id", clientDataJson: "{}", attestationObject: "ao", transports: [] },
};
const ARGS = { userId: "user-1", userEmail: "u@example.com", passkey: PASSKEY, discardedAgentPublicKey: "03cc", now: () => 5 };

describe("enrollUser", () => {
  it("presence: creates the person's key, no agent, no parent grant, and leaves the root quorum", async () => {
    const ops = fakeTurnkey();
    const doc = await enrollUser(ops, CONFIG, ARGS);

    expect(ops.calls.map((c) => c.op)).toEqual([
      "createSubOrganization",
      "createPrivateKeyTag",
      "createSigningKey",
      "listRootUsers",
      "updateRootQuorum",
    ]);
    expect(ops.calls[0]?.args).toMatchObject({
      name: "valet-signer-user-1",
      rootQuorumThreshold: 1,
      rootUsers: [
        { userName: "passkey", userEmail: "u@example.com", authenticators: [PASSKEY], apiKeys: [] },
        { userName: "valet-parent", apiKeys: [{ publicKey: "02aa", curveType: "API_KEY_CURVE_P256" }] },
      ],
    });
    expect(ops.calls[2]?.args).toEqual({ subOrgId: "suborg-1", name: "valet-signing", tagIds: ["ktag-1"] });
    expect(ops.calls[4]?.args).toEqual({ subOrgId: "suborg-1", threshold: 1, userIds: ["passkey-user"] });
    expect(doc).toEqual({
      subOrgId: "suborg-1",
      passkeyUserId: "passkey-user",
      mode: "presence",
      signingKey: {
        privateKeyId: "pk-1",
        publicKeyHex: RAW_ED25519_HEX,
        publicKey: EXPECTED_LINE,
        fingerprint: EXPECTED_FINGERPRINT,
        activityId: "act-2",
      },
      signingTagId: "ktag-1",
      createdAt: 5,
    });
  });

  it("session: adds valet-agent and a parent grant scoped to its session keys", async () => {
    const ops = fakeTurnkey();
    const doc = await enrollUser(ops, { ...CONFIG, assurance: "session" }, ARGS);

    expect(ops.calls.map((c) => c.op)).toEqual([
      "createSubOrganization",
      "createPrivateKeyTag",
      "createSigningKey",
      "listRootUsers",
      "createUsers",
      "createUserTag",
      "createPolicy",
      "createPolicy",
      "updateRootQuorum",
    ]);
    expect(ops.calls[4]?.args).toMatchObject({
      users: [{ userName: "valet-agent", apiKeys: [{ publicKey: "03cc" }], userTags: [] }],
    });
    expect(ops.calls[6]?.args).toMatchObject({
      condition: "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && private_key.tags.contains('ktag-1')",
      consensus: "approvers.any(user, user.tags.contains('utag-1'))",
    });
    const parentGrant = ops.calls[7]?.args as { condition: string; consensus: string };
    expect(parentGrant.consensus).toBe("approvers.any(user, user.id == 'parent-user')");
    expect(parentGrant.condition).toBe(
      "activity.type in ['ACTIVITY_TYPE_CREATE_API_KEYS_V2', 'ACTIVITY_TYPE_DELETE_API_KEYS'] && activity.params.user_id == 'user-1'",
    );
    expect(parentGrant.condition).not.toContain("CREATE_PRIVATE_KEYS");
    expect(doc).toMatchObject({ mode: "session", agentUserId: "user-1", agentTagId: "utag-1", policyId: "policy-1" });
  });
});
