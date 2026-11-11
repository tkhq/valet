/**
 * Turnkey Managed Secrets as a `SecretStoreProvider`.
 *
 * Each owner's space is a Turnkey sub-organization under the deployment's
 * parent organization. The broker API key is the sub-organization's only
 * root user, so Valet alone decides who reads a secret. Valet's labels become
 * Turnkey static properties at import, and the read context becomes the
 * export's request context, which Turnkey records with the activity. A later
 * Turnkey policy can check both without a re-import.
 *
 * Limit: `importSecret` encrypts the value to the Turnkey enclave inside the
 * api process, so the plaintext passes through the api once on save.
 *
 * The SDK loads by a runtime specifier, not a static import. Its declarations
 * (through `@turnkey/crypto` and the API-key stamper) carry
 * `/// <reference lib="dom" />`, which swaps `Headers`, `BodyInit`, and `Blob`
 * for the DOM versions across the whole api program and breaks unrelated
 * files. `TurnkeyApiClient` names only the calls this file makes.
 */
import { SecretStoreError, type SecretMeta, type SecretStoreProvider } from "./provider.js";

export interface TurnkeyConfig {
  apiBaseUrl: string;
  parentOrgId: string;
  apiPublicKey: string;
  apiPrivateKey: string;
}

/** All three key values, or a boot error that names the missing ones. */
export function turnkeyConfigFromEnv(env: NodeJS.ProcessEnv): TurnkeyConfig {
  const values = {
    VALET_TURNKEY_ORG_ID: env.VALET_TURNKEY_ORG_ID?.trim(),
    VALET_TURNKEY_API_PUBLIC_KEY: env.VALET_TURNKEY_API_PUBLIC_KEY?.trim(),
    VALET_TURNKEY_API_PRIVATE_KEY: env.VALET_TURNKEY_API_PRIVATE_KEY?.trim(),
  };
  const missing = Object.entries(values)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`VALET_SECRET_STORE=turnkey needs ${missing.join(", ")}. Set them, or unset VALET_SECRET_STORE.`);
  }
  return {
    apiBaseUrl: env.VALET_TURNKEY_API_BASE_URL?.trim() || "https://api.turnkey.com",
    parentOrgId: values.VALET_TURNKEY_ORG_ID!,
    apiPublicKey: values.VALET_TURNKEY_API_PUBLIC_KEY!,
    apiPrivateKey: values.VALET_TURNKEY_API_PRIVATE_KEY!,
  };
}

export interface TurnkeySecretMetadata {
  secretId: string;
  name?: string;
  createdAtUnixMs: string;
}

/** The SDK calls this provider makes. Tests pass a fake. */
export interface TurnkeyApiClient {
  createSubOrganization(input: {
    organizationId: string;
    subOrganizationName: string;
    rootQuorumThreshold: number;
    rootUsers: {
      userName: string;
      apiKeys: { apiKeyName: string; publicKey: string; curveType: "API_KEY_CURVE_P256" }[];
      authenticators: never[];
      oauthProviders: never[];
    }[];
  }): Promise<{ subOrganizationId?: string }>;
  importSecret(params: {
    organizationId: string;
    name: string;
    plaintext: string;
    staticProperties: Record<string, string>;
  }): Promise<string>;
  /** One page, newest first. `after` is the last secret id of the previous page. */
  getSecrets(params: {
    organizationId: string;
    paginationOptions: { limit: string; after?: string };
  }): Promise<TurnkeySecretMetadata[]>;
  deleteSecrets(input: { organizationId: string; secretIds: string[] }): Promise<unknown>;
  exportSecret(params: {
    organizationId: string;
    secretId: string;
    requestContext: Record<string, string>;
  }): Promise<string>;
}

interface TurnkeySdkModule {
  Turnkey: new (config: {
    apiBaseUrl: string;
    apiPublicKey: string;
    apiPrivateKey: string;
    defaultOrganizationId: string;
  }) => { apiClient(): TurnkeyApiClient };
}

const SDK_SPECIFIER = "@turnkey/sdk-server";

/** `TurnkeyErrorCodes.EXPORT_SECRET_CONSENSUS_NEEDED`. The SDK is loaded at
 * runtime (see the file comment), so its enum is not imported. */
const EXPORT_NEEDS_APPROVAL = "EXPORT_SECRET_CONSENSUS_NEEDED";

async function sdkClient(config: TurnkeyConfig): Promise<TurnkeyApiClient> {
  // A non-literal specifier types as `Promise<any>`. The annotation names the
  // shape this file relies on (see the file comment for why).
  const { Turnkey }: TurnkeySdkModule = await import(SDK_SPECIFIER);
  return new Turnkey({
    apiBaseUrl: config.apiBaseUrl,
    apiPublicKey: config.apiPublicKey,
    apiPrivateKey: config.apiPrivateKey,
    defaultOrganizationId: config.parentOrgId,
  }).apiClient();
}

/** Turnkey pages list results at 100. Ten pages bound one name lookup. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export function createTurnkeySecretStore(
  config: TurnkeyConfig,
  opts: { client?: TurnkeyApiClient } = {},
): SecretStoreProvider {
  let client: Promise<TurnkeyApiClient> | undefined = opts.client ? Promise.resolve(opts.client) : undefined;
  const api = (): Promise<TurnkeyApiClient> => (client ??= sdkClient(config));

  /** Every secret in the sub-organization, newest first. */
  async function listAll(organizationId: string): Promise<TurnkeySecretMetadata[]> {
    const out: TurnkeySecretMetadata[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await (await api()).getSecrets({
        organizationId,
        paginationOptions: { limit: String(PAGE_SIZE), ...(after ? { after } : {}) },
      });
      out.push(...batch);
      if (batch.length < PAGE_SIZE) return out;
      after = batch[batch.length - 1]!.secretId;
    }
    throw new SecretStoreError(
      `More than ${PAGE_SIZE * MAX_PAGES} secrets are saved. Delete some you no longer use.`,
      "too_many",
    );
  }

  async function findId(organizationId: string, name: string): Promise<string | null> {
    return (await listAll(organizationId)).find((s) => s.name === name)?.secretId ?? null;
  }

  return {
    id: "turnkey",
    label: "Turnkey",

    async createSpace(owner) {
      // The broker key is the only root (threshold 1). The hardening step
      // adds human roots and makes the broker a non-root user.
      const result = await (await api()).createSubOrganization({
        organizationId: config.parentOrgId,
        subOrganizationName: `valet-${owner.ownerType}-${owner.ownerId}`,
        rootQuorumThreshold: 1,
        rootUsers: [
          {
            userName: "valet-broker",
            apiKeys: [{ apiKeyName: "valet-broker", publicKey: config.apiPublicKey, curveType: "API_KEY_CURVE_P256" }],
            authenticators: [],
            oauthProviders: [],
          },
        ],
      });
      if (!result.subOrganizationId) throw new Error("Turnkey returned no sub-organization id");
      return result.subOrganizationId;
    },

    async list(spaceId) {
      return (await listAll(spaceId)).map(
        (s): SecretMeta => ({ name: s.name ?? "", createdAt: Number(s.createdAtUnixMs) }),
      );
    },

    async put(spaceId, { name, value, labels }) {
      await (await api()).importSecret({
        organizationId: spaceId,
        name,
        plaintext: value,
        staticProperties: { ...labels },
      });
    },

    async remove(spaceId, name) {
      const secretId = await findId(spaceId, name);
      if (!secretId) return false;
      await (await api()).deleteSecrets({ organizationId: spaceId, secretIds: [secretId] });
      return true;
    },

    async read(spaceId, name, context) {
      const secretId = await findId(spaceId, name);
      if (!secretId) return null;
      try {
        return await (await api()).exportSecret({ organizationId: spaceId, secretId, requestContext: { ...context } });
      } catch (err) {
        // The broker key is the only root here, so an export needs approval
        // only if someone added a policy in Turnkey. Valet does not wait for
        // approvals, so name the cause instead of the generic provider error.
        if (err instanceof Error && "code" in err && err.code === EXPORT_NEEDS_APPROVAL) {
          throw new SecretStoreError(
            "Turnkey needs an approval before it exports this secret, and Valet does not wait for approvals. Remove the approval rule for secret exports in the Turnkey organization, then run again.",
            "provider",
          );
        }
        throw err;
      }
    },
  };
}
