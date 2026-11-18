/**
 * One-time Turnkey setup per Valet user
 * (`docs/specs/2026-11-17-commit-signing-user-registered-keys-design.md`):
 * a sub-organization with the user's passkey as the only root, and the
 * person's one Ed25519 signing key. The api route posts the passkey
 * attestation from the browser and stores the result in the plugin store.
 *
 * - `presence` (`startPresenceEnrollment` + `finishPresenceEnrollment`):
 *   Valet creates the sub-organization with the passkey as its ONLY root.
 *   The parent key never joins it. The passkey itself then stamps the
 *   `CREATE_PRIVATE_KEYS_V2` that makes the signing key. Valet's server
 *   holds no authority in the sub-organization at any point; the parent
 *   organization can only read it.
 * - `session` (`enrollUser`): the parent key joins as a second root user so
 *   it can create `valet-agent`, the tags, the key, and the policies, then
 *   leaves the quorum with a grant limited to `valet-agent`'s session API
 *   keys (`parentKeyPolicy`). This mode trusts Valet's server at setup.
 */
import type { TurnkeyDeploymentConfig } from "./config.js";
import { agentSigningPolicy, parentKeyPolicy } from "./gate.js";
import { opensshEd25519PublicKey } from "./ssh.js";
import type { EnrollmentDoc } from "./store.js";
import type { RootUserParams, TurnkeyActivity, TurnkeyOps } from "./turnkey-client.js";

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

/** Step one of presence setup: the sub-organization, with the passkey as its only root. */
export async function startPresenceEnrollment(
  ops: TurnkeyOps,
  args: { userId: string; userEmail?: string; passkey: PasskeyAuthenticator; now?: () => number },
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
    ],
  });
  const roots = await ops.listRootUsers({ subOrgId: sub.subOrgId });
  const passkeyUser = roots.find((u) => u.userName === "passkey");
  if (!passkeyUser || roots.length !== 1) throw new Error("Turnkey created the organization with an unexpected root quorum. Set up again.");
  return { subOrgId: sub.subOrgId, passkeyUserId: passkeyUser.userId, mode: "presence", pendingKey: true, createdAt: (args.now ?? Date.now)() };
}

const CREATE_KEYS = "ACTIVITY_TYPE_CREATE_PRIVATE_KEYS_V2";
const KEY_STEP_MAX_AGE_MS = 5 * 60_000;

/** The unsigned request the passkey stamps to create the signing key. */
export function keyCreationBody(subOrgId: string, now: number): string {
  return JSON.stringify({
    type: CREATE_KEYS,
    timestampMs: String(now),
    organizationId: subOrgId,
    parameters: { privateKeys: [{ privateKeyName: SIGNING_KEY_NAME, curve: "CURVE_ED25519", privateKeyTags: [], addressFormats: [] }] },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Why a stamped body is not the key-creation request Valet issued, or null. */
export function keyCreationRefusal(body: string, subOrgId: string, now: number): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return "The signed request is not JSON. Set up again.";
  }
  if (!isRecord(parsed) || parsed.type !== CREATE_KEYS || parsed.organizationId !== subOrgId) return "The signed request is not the key creation step. Set up again.";
  const keys = isRecord(parsed.parameters) ? parsed.parameters.privateKeys : undefined;
  const key = Array.isArray(keys) && keys.length === 1 ? keys[0] : undefined;
  if (!isRecord(key) || key.curve !== "CURVE_ED25519" || key.privateKeyName !== SIGNING_KEY_NAME) return "The signed request creates a different key. Set up again.";
  const ts = typeof parsed.timestampMs === "string" ? Number(parsed.timestampMs) : NaN;
  if (!Number.isFinite(ts) || ts < now - KEY_STEP_MAX_AGE_MS || ts > now + 60_000) return "The signed request is too old. Choose Finish setup again.";
  return null;
}

/** Step two: records the key the passkey created, after checking Turnkey's activity. */
export async function finishPresenceEnrollment(
  ops: TurnkeyOps,
  pending: EnrollmentDoc,
  activity: TurnkeyActivity,
  now: () => number = Date.now,
): Promise<EnrollmentDoc> {
  if (activity.type !== CREATE_KEYS || activity.organizationId !== pending.subOrgId || activity.status !== "ACTIVITY_STATUS_COMPLETED") {
    throw new Error(`Turnkey did not create the signing key (${activity.type}, ${activity.status}). Choose Finish setup again.`);
  }
  if (!activity.votes.some((v) => v.userId === pending.passkeyUserId && v.selection === "VOTE_SELECTION_APPROVED")) {
    throw new Error("Turnkey did not record your passkey on the key creation. Choose Finish setup again.");
  }
  const privateKeyId = activity.result?.createdPrivateKeyIds?.[0];
  if (!privateKeyId) throw new Error("Turnkey returned no key id. Choose Finish setup again.");
  const publicKeyHex = await ops.getPrivateKeyPublicHex({ subOrgId: pending.subOrgId, privateKeyId });
  const ssh = opensshEd25519PublicKey(publicKeyHex);
  const { pendingKey: _done, ...rest } = pending;
  return { ...rest, signingKey: { privateKeyId, publicKeyHex, publicKey: ssh.line, fingerprint: ssh.fingerprint, activityId: activity.id }, createdAt: now() };
}
