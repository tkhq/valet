/**
 * One-time Turnkey setup per Valet user
 * (`docs/specs/2026-11-17-commit-signing-user-registered-keys-design.md`):
 * a sub-organization with the user's passkey as the only root, and the
 * person's one Ed25519 signing key. The api route posts the passkey
 * attestation from the browser and stores the result in the plugin store.
 *
 * The parent API key joins the new sub-organization as a second root user
 * (threshold 1) so it can create the key (and, in session mode, the agent
 * user, tags, and policies) in this flow. It leaves the root quorum in the
 * last step.
 *
 * - `presence`: no `valet-agent`, no parent grant. After enrollment the
 *   parent key has no authority in the sub-organization. Only the passkey
 *   can sign, one stamped activity at a time.
 * - `session`: adds `valet-agent`, its signing policy, and a parent grant
 *   limited to `valet-agent`'s session API keys (`parentKeyPolicy`).
 */
import type { TurnkeyDeploymentConfig } from "./config.js";
import { agentSigningPolicy, parentKeyPolicy } from "./gate.js";
import { opensshEd25519PublicKey } from "./ssh.js";
import type { EnrollmentDoc } from "./store.js";
import type { RootUserParams, TurnkeyOps } from "./turnkey-client.js";

export const AGENT_USER_NAME = "valet-agent";
export const AGENT_TAG_NAME = "agent-session";
export const SIGNING_TAG_NAME = "agent-signing";
export const SIGNING_KEY_NAME = "valet-signing";
export const PARENT_ROOT_USER_NAME = "valet-parent";

export type PasskeyAuthenticator = RootUserParams["authenticators"][number];

export interface EnrollArgs {
  userId: string;
  userEmail?: string;
  passkey: PasskeyAuthenticator;
  /**
   * A P-256 public key for `valet-agent`'s first credential (session mode).
   * Turnkey refuses a user with no non-expiring credential, so the caller
   * generates a key pair, passes the public half here, and discards the
   * private half. The credential then authenticates nothing.
   */
  discardedAgentPublicKey: string;
  now?: () => number;
}

export function subOrgName(userId: string): string {
  return `valet-signer-${userId}`;
}

export async function enrollUser(
  ops: TurnkeyOps,
  config: TurnkeyDeploymentConfig,
  args: EnrollArgs,
): Promise<EnrollmentDoc> {
  const sub = await ops.createSubOrganization({
    name: subOrgName(args.userId),
    rootQuorumThreshold: 1,
    rootUsers: [
      {
        userName: "passkey",
        ...(args.userEmail ? { userEmail: args.userEmail } : {}),
        apiKeys: [],
        authenticators: [args.passkey],
        oauthProviders: [],
      },
      {
        userName: PARENT_ROOT_USER_NAME,
        apiKeys: [{ apiKeyName: "valet-parent", publicKey: config.apiPublicKey, curveType: "API_KEY_CURVE_P256" }],
        authenticators: [],
        oauthProviders: [],
      },
    ],
  });

  const signingTag = await ops.createPrivateKeyTag({ subOrgId: sub.subOrgId, name: SIGNING_TAG_NAME, privateKeyIds: [] });
  const key = await ops.createSigningKey({ subOrgId: sub.subOrgId, name: SIGNING_KEY_NAME, tagIds: [signingTag.tagId] });
  const ssh = opensshEd25519PublicKey(key.publicKeyHex);

  const roots = await ops.listRootUsers({ subOrgId: sub.subOrgId });
  const passkeyUser = roots.find((u) => u.userName === "passkey");
  if (!passkeyUser) throw new Error("Turnkey sub-organization has no passkey root user.");
  const parentUser = roots.find((u) => u.userName === PARENT_ROOT_USER_NAME);
  if (!parentUser) throw new Error("Turnkey sub-organization has no parent root user.");

  let session: Pick<EnrollmentDoc, "agentUserId" | "agentTagId" | "policyId"> = {};
  if (config.assurance === "session") {
    const users = await ops.createUsers({
      subOrgId: sub.subOrgId,
      users: [
        {
          userName: AGENT_USER_NAME,
          apiKeys: [{ apiKeyName: "discarded", publicKey: args.discardedAgentPublicKey, curveType: "API_KEY_CURVE_P256" }],
          authenticators: [],
          oauthProviders: [],
          userTags: [],
        },
      ],
    });
    const agentUserId = users.userIds[0];
    if (!agentUserId) throw new Error("Turnkey created no agent user.");
    const agentTag = await ops.createUserTag({ subOrgId: sub.subOrgId, name: AGENT_TAG_NAME, userIds: [agentUserId] });
    const policy = await ops.createPolicy({ subOrgId: sub.subOrgId, ...agentSigningPolicy(agentTag.tagId, signingTag.tagId) });
    await ops.createPolicy({ subOrgId: sub.subOrgId, ...parentKeyPolicy(parentUser.userId, agentUserId) });
    session = { agentUserId, agentTagId: agentTag.tagId, policyId: policy.policyId };
  }

  // The parent key leaves: only the passkey remains root.
  await ops.updateRootQuorum({ subOrgId: sub.subOrgId, threshold: 1, userIds: [passkeyUser.userId] });

  return {
    subOrgId: sub.subOrgId,
    passkeyUserId: passkeyUser.userId,
    mode: config.assurance,
    signingKey: {
      privateKeyId: key.privateKeyId,
      publicKeyHex: key.publicKeyHex,
      publicKey: ssh.line,
      fingerprint: ssh.fingerprint,
      activityId: key.activityId,
    },
    signingTagId: signingTag.tagId,
    ...session,
    createdAt: (args.now ?? Date.now)(),
  };
}
