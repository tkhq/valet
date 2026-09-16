/**
 * One-time Turnkey setup per Valet user: a sub-organization with the user's
 * passkey as the only root, a `valet-agent` user for session API keys, the
 * two tags, and the one allow policy. The api route posts the passkey
 * attestation from the browser and stores the result in the plugin store.
 *
 * The parent API key joins the new sub-organization as a second root user
 * (threshold 1) so it can create the agent user, tags and policy in this
 * flow, and leaves the root quorum in the last step. After that the parent
 * key has no authority in the sub-organization at all: it cannot create
 * keys, sign, or change policies.
 */
import type { TurnkeyDeploymentConfig } from "./config.js";
import { agentSigningPolicy } from "./gate.js";
import type { EnrollmentDoc } from "./store.js";
import type { RootUserParams, TurnkeyOps } from "./turnkey-client.js";

export const AGENT_USER_NAME = "valet-agent";
export const AGENT_TAG_NAME = "agent-session";
export const SIGNING_TAG_NAME = "agent-signing";
export const PARENT_ROOT_USER_NAME = "valet-parent";

export type PasskeyAuthenticator = RootUserParams["authenticators"][number];

export interface EnrollArgs {
  userId: string;
  userEmail?: string;
  passkey: PasskeyAuthenticator;
  /**
   * A P-256 public key for `valet-agent`'s first credential. Turnkey refuses
   * a user with no non-expiring credential, so the caller generates a key
   * pair, passes the public half here, and discards the private half. The
   * credential then authenticates nothing.
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
  const signingTag = await ops.createPrivateKeyTag({ subOrgId: sub.subOrgId, name: SIGNING_TAG_NAME, privateKeyIds: [] });
  const policy = await ops.createPolicy({ subOrgId: sub.subOrgId, ...agentSigningPolicy(agentTag.tagId, signingTag.tagId) });

  // Find the two root user ids: the passkey stays, the parent key leaves.
  const roots = await ops.listRootUsers({ subOrgId: sub.subOrgId });
  const passkeyUser = roots.find((u) => u.userName === "passkey");
  if (!passkeyUser) throw new Error("Turnkey sub-organization has no passkey root user.");
  await ops.updateRootQuorum({ subOrgId: sub.subOrgId, threshold: 1, userIds: [passkeyUser.userId] });

  return {
    subOrgId: sub.subOrgId,
    passkeyUserId: passkeyUser.userId,
    agentUserId,
    agentTagId: agentTag.tagId,
    signingTagId: signingTag.tagId,
    policyId: policy.policyId,
    createdAt: (args.now ?? Date.now)(),
  };
}
