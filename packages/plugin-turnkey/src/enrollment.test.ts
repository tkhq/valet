import { describe, expect, it } from "vitest";
import type { TurnkeyDeploymentConfig } from "./config.js";
import { enrollUser, finishPresenceEnrollment, keyCreationBody, keyCreationRefusal, startPresenceEnrollment } from "./enrollment.js";
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

describe("presence enrollment", () => {
  it("creates the organization with the passkey as its only root; the parent never joins", async () => {
    const ops = fakeTurnkey();
    const pending = await startPresenceEnrollment(ops, { userId: "user-1", passkey: PASSKEY, now: () => 5 });
    expect(ops.calls.map((c) => c.op)).toEqual(["createSubOrganization", "listRootUsers"]);
    const create = ops.calls[0]?.args as { rootUsers: Array<{ userName: string; apiKeys: unknown[] }> };
    expect(create.rootUsers).toHaveLength(1);
    expect(create.rootUsers[0]).toMatchObject({ userName: "passkey", apiKeys: [] });
    expect(pending).toEqual({ subOrgId: "suborg-1", passkeyUserId: "passkey-user", mode: "presence", pendingKey: true, createdAt: 5 });
  });

  it("issues a key-creation body and refuses any other", () => {
    const body = keyCreationBody("suborg-1", 1000);
    expect(keyCreationRefusal(body, "suborg-1", 2000)).toBeNull();
    expect(keyCreationRefusal(body, "suborg-2", 2000)).toContain("not the key creation step");
    expect(keyCreationRefusal(body.replace("CURVE_ED25519", "CURVE_SECP256K1"), "suborg-1", 2000)).toContain("different key");
    expect(keyCreationRefusal(body, "suborg-1", 1000 + 6 * 60_000)).toContain("too old");
  });

  it("records the key only from a completed activity the passkey approved", async () => {
    const ops = fakeTurnkey();
    const pending = { subOrgId: "suborg-1", passkeyUserId: "passkey-user", mode: "presence" as const, pendingKey: true as const, createdAt: 5 };
    const activity = {
      id: "act-9", organizationId: "suborg-1", status: "ACTIVITY_STATUS_COMPLETED", type: "ACTIVITY_TYPE_CREATE_PRIVATE_KEYS_V2",
      votes: [{ userId: "passkey-user", selection: "VOTE_SELECTION_APPROVED" }], result: { createdPrivateKeyIds: ["pk-9"] },
    };
    const done = await finishPresenceEnrollment(ops, pending, activity, () => 7);
    expect(done).toEqual({
      subOrgId: "suborg-1", passkeyUserId: "passkey-user", mode: "presence", createdAt: 7,
      signingKey: { privateKeyId: "pk-9", publicKeyHex: RAW_ED25519_HEX, publicKey: EXPECTED_LINE, fingerprint: EXPECTED_FINGERPRINT, activityId: "act-9" },
    });
    await expect(finishPresenceEnrollment(ops, pending, { ...activity, votes: [] })).rejects.toThrow("passkey");
  });
});
