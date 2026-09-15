/**
 * The Turnkey calls commit signing makes, behind one interface so the action
 * and the api routes are tested against a fake. `turnkeyOps` is the real
 * implementation over `@turnkey/sdk-server`, which stamps every request with
 * the deployment's parent API key and polls each activity to completion.
 */
import { Turnkey } from "@turnkey/sdk-server";
import type { TurnkeyDeploymentConfig } from "./config.js";

// The parameter shapes are declared here rather than derived from the SDK's
// types on purpose: the api package imports this module's declarations, and
// a type derived from `@turnkey/sdk-server` drags that package's typings
// (cross-fetch, buffer) into the api program, where they redefine `Headers`
// and `Blob` and break unrelated files. These mirror
// `v1ApiKeyParamsV2`, `v1AuthenticatorParamsV2`, `v1RootUserParamsV5`, and
// `v1UserParamsV4`; the SDK checks them structurally at the call sites below.

export type AuthenticatorTransport =
  | "AUTHENTICATOR_TRANSPORT_BLE"
  | "AUTHENTICATOR_TRANSPORT_INTERNAL"
  | "AUTHENTICATOR_TRANSPORT_NFC"
  | "AUTHENTICATOR_TRANSPORT_USB"
  | "AUTHENTICATOR_TRANSPORT_HYBRID";

export interface ApiKeyParams {
  apiKeyName: string;
  /** Compressed P-256 point, hex. */
  publicKey: string;
  curveType: "API_KEY_CURVE_P256";
  expirationSeconds?: string;
}

export interface AuthenticatorParams {
  authenticatorName: string;
  challenge: string;
  attestation: {
    credentialId: string;
    clientDataJson: string;
    attestationObject: string;
    transports: AuthenticatorTransport[];
  };
}

export interface RootUserParams {
  userName: string;
  userEmail?: string;
  apiKeys: ApiKeyParams[];
  authenticators: AuthenticatorParams[];
  /** Always empty here; typed so the literal `[]` satisfies the SDK. */
  oauthProviders: never[];
}

export interface UserParams extends RootUserParams {
  userTags: string[];
}

export interface PolicyParams {
  policyName: string;
  effect: "EFFECT_ALLOW" | "EFFECT_DENY";
  condition: string;
  consensus: string;
  notes: string;
}

export interface TurnkeyOps {
  createSubOrganization(args: {
    name: string;
    rootUsers: RootUserParams[];
    rootQuorumThreshold: number;
  }): Promise<{ subOrgId: string; activityId: string }>;
  createUsers(args: { subOrgId: string; users: UserParams[] }): Promise<{ userIds: string[]; activityId: string }>;
  createUserTag(args: { subOrgId: string; name: string; userIds: string[] }): Promise<{ tagId: string }>;
  createPrivateKeyTag(args: { subOrgId: string; name: string; privateKeyIds: string[] }): Promise<{ tagId: string }>;
  createPolicy(args: { subOrgId: string } & PolicyParams): Promise<{ policyId: string }>;
  /** The users in the sub-organization's root quorum. */
  listRootUsers(args: { subOrgId: string }): Promise<Array<{ userId: string; userName: string }>>;
  updateRootQuorum(args: { subOrgId: string; threshold: number; userIds: string[] }): Promise<void>;
  /** An Ed25519 key for one approval. Returns the raw public key as hex. */
  createSigningKey(args: {
    subOrgId: string;
    name: string;
    tagIds: string[];
  }): Promise<{ privateKeyId: string; publicKeyHex: string; activityId: string }>;
  /** An expiring P-256 API key on `valet-agent` for one session. */
  createApiKey(args: {
    subOrgId: string;
    userId: string;
    name: string;
    publicKey: string;
    expirationSeconds: number;
  }): Promise<{ apiKeyId: string; activityId: string }>;
  deleteApiKeys(args: { subOrgId: string; userId: string; apiKeyIds: string[] }): Promise<void>;
}

export type TurnkeyOpsFactory = (config: TurnkeyDeploymentConfig) => TurnkeyOps;

export function turnkeyOps(config: TurnkeyDeploymentConfig): TurnkeyOps {
  const api = new Turnkey({
    apiBaseUrl: config.apiBaseUrl,
    apiPublicKey: config.apiPublicKey,
    apiPrivateKey: config.apiPrivateKey,
    defaultOrganizationId: config.organizationId,
    // Every call here is a root-quorum-1 or policy-allowed activity; a
    // pending one is a configuration error, not something to wait a long time for.
    activityPoller: { intervalMs: 500, numRetries: 20 },
  }).apiClient();

  return {
    async createSubOrganization({ name, rootUsers, rootQuorumThreshold }) {
      const res = await api.createSubOrganization({
        organizationId: config.organizationId,
        subOrganizationName: name,
        rootUsers,
        rootQuorumThreshold,
      });
      return { subOrgId: res.subOrganizationId, activityId: res.activity.id };
    },
    async createUsers({ subOrgId, users }) {
      const res = await api.createUsers({ organizationId: subOrgId, users });
      return { userIds: res.userIds, activityId: res.activity.id };
    },
    async createUserTag({ subOrgId, name, userIds }) {
      const res = await api.createUserTag({ organizationId: subOrgId, userTagName: name, userIds });
      return { tagId: res.userTagId };
    },
    async createPrivateKeyTag({ subOrgId, name, privateKeyIds }) {
      const res = await api.createPrivateKeyTag({ organizationId: subOrgId, privateKeyTagName: name, privateKeyIds });
      return { tagId: res.privateKeyTagId };
    },
    async createPolicy({ subOrgId, ...policy }) {
      const res = await api.createPolicy({ organizationId: subOrgId, ...policy });
      return { policyId: res.policyId };
    },
    async listRootUsers({ subOrgId }) {
      const [configs, users] = await Promise.all([
        api.getOrganizationConfigs({ organizationId: subOrgId }),
        api.getUsers({ organizationId: subOrgId }),
      ]);
      const quorum = new Set(configs.configs.quorum?.userIds ?? []);
      return users.users.filter((u) => quorum.has(u.userId)).map((u) => ({ userId: u.userId, userName: u.userName }));
    },
    async updateRootQuorum({ subOrgId, threshold, userIds }) {
      await api.updateRootQuorum({ organizationId: subOrgId, threshold, userIds });
    },
    async createSigningKey({ subOrgId, name, tagIds }) {
      const created = await api.createPrivateKeys({
        organizationId: subOrgId,
        privateKeys: [{ privateKeyName: name, curve: "CURVE_ED25519", privateKeyTags: tagIds, addressFormats: [] }],
      });
      const privateKeyId = created.privateKeys[0]?.privateKeyId;
      if (!privateKeyId) throw new Error("Turnkey created no private key.");
      // The create result carries ids and addresses only; the public key is a read.
      const read = await api.getPrivateKey({ organizationId: subOrgId, privateKeyId });
      return { privateKeyId, publicKeyHex: read.privateKey.publicKey, activityId: created.activity.id };
    },
    async createApiKey({ subOrgId, userId, name, publicKey, expirationSeconds }) {
      const res = await api.createApiKeys({
        organizationId: subOrgId,
        userId,
        apiKeys: [
          {
            apiKeyName: name,
            publicKey,
            curveType: "API_KEY_CURVE_P256",
            expirationSeconds: String(Math.floor(expirationSeconds)),
          },
        ],
      });
      const apiKeyId = res.apiKeyIds[0];
      if (!apiKeyId) throw new Error("Turnkey created no API key.");
      return { apiKeyId, activityId: res.activity.id };
    },
    async deleteApiKeys({ subOrgId, userId, apiKeyIds }) {
      await api.deleteApiKeys({ organizationId: subOrgId, userId, apiKeyIds });
    },
  };
}
