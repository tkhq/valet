import { describe, expect, it } from "vitest";
import { enrollUser } from "./enrollment.js";
import { fakeTurnkey } from "./test-helpers/fakes.js";

const CONFIG = { organizationId: "parent", apiPublicKey: "02aa", apiPrivateKey: "bb", apiBaseUrl: "https://api" };
const PASSKEY = {
  authenticatorName: "passkey",
  challenge: "c",
  attestation: { credentialId: "id", clientDataJson: "{}", attestationObject: "ao", transports: [] },
};

describe("enrollUser", () => {
  it("creates the sub-organization, agent user, tags, policy, and leaves the root quorum", async () => {
    const ops = fakeTurnkey();
    const doc = await enrollUser(ops, CONFIG, {
      userId: "user-1",
      userEmail: "u@example.com",
      passkey: PASSKEY,
      discardedAgentPublicKey: "03cc",
      now: () => 5,
    });

    expect(ops.calls.map((c) => c.op)).toEqual([
      "createSubOrganization",
      "createUsers",
      "createUserTag",
      "createPrivateKeyTag",
      "createPolicy",
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
    // The agent user's only credential is a key nobody holds, and it has no expiry.
    expect(ops.calls[1]?.args).toMatchObject({
      users: [{ userName: "valet-agent", apiKeys: [{ publicKey: "03cc" }], userTags: [] }],
    });
    expect(ops.calls[4]?.args).toMatchObject({
      condition: "activity.type == 'ACTIVITY_TYPE_SIGN_RAW_PAYLOAD_V2' && private_key.tags.contains('ktag-1')",
      consensus: "approvers.any(user, user.tags.contains('utag-1'))",
    });
    // The parent key leaves: only the passkey remains root.
    expect(ops.calls[6]?.args).toEqual({ subOrgId: "suborg-1", threshold: 1, userIds: ["passkey-user"] });

    expect(doc).toEqual({
      subOrgId: "suborg-1",
      passkeyUserId: "passkey-user",
      agentUserId: "user-1",
      agentTagId: "utag-1",
      signingTagId: "ktag-1",
      policyId: "policy-1",
      createdAt: 5,
    });
  });
});
