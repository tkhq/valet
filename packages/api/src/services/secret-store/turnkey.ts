/**
 * Turnkey Managed Secrets as a `SecretStoreProvider`.
 *
 * Two ordinary, non-root Turnkey users act for Valet:
 * - the **provisioner** creates personal sub-organizations and imports or
 *   deletes secrets;
 * - the **broker** exports secrets.
 * Their policies in the deployment organization come from root-authorized
 * bootstrap (`docs/environment-variables.md`). Root authority stays with the
 * organization's human root quorum.
 *
 * Spaces: the deployment organization holds company and team secrets. Each
 * user's personal space is a sub-organization. The provisioner creates it
 * with both service users as roots at threshold 1, adds the two personal
 * policies, then raises the root quorum to 2. After that neither key alone
 * can bypass a policy in the sub-organization.
 *
 * Valet's labels become static properties at import. The read context
 * becomes the export's request context. The export policies compare the
 * two, so an export with the wrong context fails in Turnkey, and the
 * activity log records the context.
 *
 * The SDK loads by a runtime specifier, not a static import. Its declarations
 * (through `@turnkey/crypto` and the API-key stamper) carry
 * `/// <reference lib="dom" />`, which swaps `Headers`, `BodyInit`, and `Blob`
 * for the DOM versions across the whole api program and breaks unrelated
 * files. `TurnkeyApiClient` names only the calls this file makes.
 */
import {
  SecretStoreError,
  type SealEnvelope,
  type SecretMeta,
  type SecretStoreProvider,
} from "./provider.js";

export interface TurnkeyKeyPair {
  apiPublicKey: string;
  apiPrivateKey: string;
}

export interface TurnkeyConfig {
  apiBaseUrl: string;
  orgId: string;
  provisioner: TurnkeyKeyPair;
  broker: TurnkeyKeyPair;
}

/** Every key value, or a boot error that names the missing ones. */
export function turnkeyConfigFromEnv(env: NodeJS.ProcessEnv): TurnkeyConfig {
  const values = {
    VALET_TURNKEY_ORG_ID: env.VALET_TURNKEY_ORG_ID?.trim(),
    VALET_TURNKEY_PROVISIONER_API_PUBLIC_KEY: env.VALET_TURNKEY_PROVISIONER_API_PUBLIC_KEY?.trim(),
    VALET_TURNKEY_PROVISIONER_API_PRIVATE_KEY: env.VALET_TURNKEY_PROVISIONER_API_PRIVATE_KEY?.trim(),
    VALET_TURNKEY_BROKER_API_PUBLIC_KEY: env.VALET_TURNKEY_BROKER_API_PUBLIC_KEY?.trim(),
    VALET_TURNKEY_BROKER_API_PRIVATE_KEY: env.VALET_TURNKEY_BROKER_API_PRIVATE_KEY?.trim(),
  };
  const missing = Object.entries(values)
    .filter(([, v]) => !v)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`VALET_SECRET_STORE=turnkey needs ${missing.join(", ")}. Set them, or unset VALET_SECRET_STORE.`);
  }
  if (values.VALET_TURNKEY_PROVISIONER_API_PUBLIC_KEY === values.VALET_TURNKEY_BROKER_API_PUBLIC_KEY) {
    throw new Error("The provisioner and broker must use different Turnkey API keys. Create one key for each user.");
  }
  return {
    apiBaseUrl: env.VALET_TURNKEY_API_BASE_URL?.trim() || "https://api.turnkey.com",
    orgId: values.VALET_TURNKEY_ORG_ID!,
    provisioner: {
      apiPublicKey: values.VALET_TURNKEY_PROVISIONER_API_PUBLIC_KEY!,
      apiPrivateKey: values.VALET_TURNKEY_PROVISIONER_API_PRIVATE_KEY!,
    },
    broker: {
      apiPublicKey: values.VALET_TURNKEY_BROKER_API_PUBLIC_KEY!,
      apiPrivateKey: values.VALET_TURNKEY_BROKER_API_PRIVATE_KEY!,
    },
  };
}

/**
 * What `createSubOrganization` returns. The SDK spreads the result it names
 * over the raw activity, so the id is at the top level only when that name
 * matches the result Turnkey sends. `@turnkey/sdk-server` 8.9.0 submits the
 * V8 activity and names `createSubOrganizationResultV9`, so Turnkey's
 * `createSubOrganizationResultV8` reaches only `activity.result`.
 */
export interface CreateSubOrganizationResponse {
  subOrganizationId?: string;
  activity?: { result?: Record<string, { subOrganizationId?: string } | undefined> };
}

/** The new sub-organization's id, wherever this SDK version puts it. */
export function subOrganizationIdOf(response: CreateSubOrganizationResponse): string | undefined {
  if (response.subOrganizationId) return response.subOrganizationId;
  const result = response.activity?.result ?? {};
  for (const [key, value] of Object.entries(result)) {
    if (key.startsWith("createSubOrganizationResult") && value?.subOrganizationId) return value.subOrganizationId;
  }
  return undefined;
}

export interface TurnkeySecretMetadata {
  secretId: string;
  name?: string;
  createdAtUnixMs: string;
}

/** Turnkey's name for the sealed-import encryption. */
export const ENCLAVE_ENCRYPT_V1 = "TRANSPORT_ENCRYPTION_SUITE_ENCLAVE_ENCRYPT_V1";
/** The envelope kind the web sealer for this provider handles. */
export const TURNKEY_SEAL_KIND = "turnkey-enclave-v1";

/** User names of the two service users inside a personal sub-organization. */
export const PROVISIONER_USER_NAME = "valet-root";
export const BROKER_USER_NAME = "valet-broker";

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
  }): Promise<CreateSubOrganizationResponse>;
  getUsers(input: { organizationId: string }): Promise<{ users: { userId: string; userName: string }[] }>;
  createPolicy(input: {
    organizationId: string;
    policyName: string;
    effect: "EFFECT_ALLOW";
    consensus: string;
    condition: string;
    notes: string;
  }): Promise<{ policyId?: string }>;
  updateRootQuorum(input: { organizationId: string; threshold: number; userIds: string[] }): Promise<unknown>;
  /** The SDK's raw activity helper; `init_import_secrets` has no generated method. */
  command(url: string, body: Record<string, unknown>, resultKey: string): Promise<{ enclaveTargetMessages?: string[] }>;
  importSecrets(input: {
    organizationId: string;
    secrets: {
      name: string;
      secretPayload: string;
      targetPublicKey: string;
      encryptionSuite: string;
      staticProperties: { key: string; value: string }[];
    }[];
  }): Promise<{ secretIds?: string[] }>;
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
/** gRPC PERMISSION_DENIED: no policy allows this export, for example because
 * the request context does not match the secret's labels. */
const PERMISSION_DENIED = 7;

async function sdkClient(config: TurnkeyConfig, keys: TurnkeyKeyPair): Promise<TurnkeyApiClient> {
  // A non-literal specifier types as `Promise<any>`. The annotation names the
  // shape this file relies on (see the file comment for why).
  const { Turnkey }: TurnkeySdkModule = await import(SDK_SPECIFIER);
  return new Turnkey({
    apiBaseUrl: config.apiBaseUrl,
    apiPublicKey: keys.apiPublicKey,
    apiPrivateKey: keys.apiPrivateKey,
    defaultOrganizationId: config.orgId,
  }).apiClient();
}

/** The provisioner's grant inside a personal sub-organization. */
export function personalProvisionerPolicy(provisionerUserId: string) {
  return {
    policyName: "valet-root: import and delete personal secrets",
    effect: "EFFECT_ALLOW" as const,
    consensus: `approvers.any(u, u.id == '${provisionerUserId}')`,
    condition:
      "activity.type in ['ACTIVITY_TYPE_INIT_IMPORT_SECRETS', 'ACTIVITY_TYPE_IMPORT_SECRETS', 'ACTIVITY_TYPE_DELETE_SECRETS']",
    notes: "Valet personal secrets. The provisioner cannot export.",
  };
}

/** The broker's grant inside a personal sub-organization: export only to a
 * session the secret's owner owns. A missing context key makes the
 * condition error, and an erroring allow does not allow. */
export function personalBrokerPolicy(brokerUserId: string) {
  return {
    policyName: "valet-broker: export personal secrets",
    effect: "EFFECT_ALLOW" as const,
    consensus: `approvers.any(u, u.id == '${brokerUserId}')`,
    condition: [
      "activity.type == 'ACTIVITY_TYPE_EXPORT_SECRETS'",
      "secret.static_properties['scope'] == 'personal'",
      "request_context['valet_company_org_id'] == secret.static_properties['valet_company_org_id']",
      "request_context['valet_user_id'] == secret.static_properties['valet_owner_user_id']",
      "request_context['valet_session_owner_type'] == 'user'",
      "request_context['valet_session_owner_id'] == secret.static_properties['valet_owner_user_id']",
    ].join(" && "),
    notes: "Valet personal secrets. Export needs the owner's own session in the request context.",
  };
}

/** Turnkey pages list results at 100. Ten pages bound one name lookup. */
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

export function createTurnkeySecretStore(
  config: TurnkeyConfig,
  opts: { provisioner?: TurnkeyApiClient; broker?: TurnkeyApiClient } = {},
): SecretStoreProvider {
  let provisionerClient: Promise<TurnkeyApiClient> | undefined = opts.provisioner ? Promise.resolve(opts.provisioner) : undefined;
  let brokerClient: Promise<TurnkeyApiClient> | undefined = opts.broker ? Promise.resolve(opts.broker) : undefined;
  const provisioner = (): Promise<TurnkeyApiClient> => (provisionerClient ??= sdkClient(config, config.provisioner));
  const broker = (): Promise<TurnkeyApiClient> => (brokerClient ??= sdkClient(config, config.broker));

  /** Every secret in the organization, newest first. */
  async function listAll(organizationId: string): Promise<TurnkeySecretMetadata[]> {
    const out: TurnkeySecretMetadata[] = [];
    let after: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const batch = await (await provisioner()).getSecrets({
        organizationId,
        paginationOptions: { limit: String(PAGE_SIZE), ...(after ? { after } : {}) },
      });
      out.push(...batch);
      if (batch.length < PAGE_SIZE) return out;
      after = batch[batch.length - 1]!.secretId;
    }
    throw new SecretStoreError(
      `More than ${PAGE_SIZE * MAX_PAGES} secrets are saved in one place. Delete some you no longer use.`,
      "too_many",
    );
  }

  async function findId(organizationId: string, name: string): Promise<string | null> {
    return (await listAll(organizationId)).find((s) => s.name === name)?.secretId ?? null;
  }

  return {
    id: "turnkey",
    label: "Turnkey",

    deploymentSpace() {
      return config.orgId;
    },

    async createPersonalSpace(owner) {
      const client = await provisioner();
      const apiKey = (name: string, publicKey: string) => ({
        userName: name,
        apiKeys: [{ apiKeyName: name, publicKey, curveType: "API_KEY_CURVE_P256" as const }],
        authenticators: [],
        oauthProviders: [],
      });
      // Threshold 1 only while the provisioner adds the policies below.
      const result = await client.createSubOrganization({
        organizationId: config.orgId,
        subOrganizationName: `valet-user-${owner.userId}`,
        rootQuorumThreshold: 1,
        rootUsers: [
          apiKey(PROVISIONER_USER_NAME, config.provisioner.apiPublicKey),
          apiKey(BROKER_USER_NAME, config.broker.apiPublicKey),
        ],
      });
      const subOrgId = subOrganizationIdOf(result);
      if (!subOrgId) throw new Error("Turnkey returned no sub-organization id");
      const { users } = await client.getUsers({ organizationId: subOrgId });
      const provisionerId = users.find((u) => u.userName === PROVISIONER_USER_NAME)?.userId;
      const brokerId = users.find((u) => u.userName === BROKER_USER_NAME)?.userId;
      if (!provisionerId || !brokerId) throw new Error("Turnkey sub-organization is missing a Valet service user");
      await client.createPolicy({ organizationId: subOrgId, ...personalProvisionerPolicy(provisionerId) });
      await client.createPolicy({ organizationId: subOrgId, ...personalBrokerPolicy(brokerId) });
      // From here a root action needs both keys; each key alone has only its policy.
      await client.updateRootQuorum({ organizationId: subOrgId, threshold: 2, userIds: [provisionerId, brokerId] });
      return subOrgId;
    },

    async list(spaceId, prefix) {
      return (await listAll(spaceId))
        .filter((s) => (s.name ?? "").startsWith(prefix))
        .map((s): SecretMeta => ({ name: s.name ?? "", id: s.secretId, createdAt: Number(s.createdAtUnixMs) }));
    },

    async put(spaceId, { name, value, labels }) {
      await (await provisioner()).importSecret({
        organizationId: spaceId,
        name,
        plaintext: value,
        staticProperties: { ...labels },
      });
    },

    async beginImport(spaceId) {
      const init = await (await provisioner()).command(
        "/public/v1/submit/init_import_secrets",
        {
          type: "ACTIVITY_TYPE_INIT_IMPORT_SECRETS",
          timestampMs: String(Date.now()),
          organizationId: spaceId,
          parameters: { encryptionSuite: ENCLAVE_ENCRYPT_V1, numSecrets: 1 },
        },
        "initImportSecretsResult",
      );
      const ingressTargetBundle = init.enclaveTargetMessages?.[0];
      if (!ingressTargetBundle) throw new Error("Turnkey returned no import target");
      const envelope: SealEnvelope = { kind: TURNKEY_SEAL_KIND, ingressTargetBundle, organizationId: spaceId };
      return envelope;
    },

    async finishImport(spaceId, { name, sealed, labels }) {
      const { secretPayload, targetPublicKey } = sealed;
      if (sealed.kind !== TURNKEY_SEAL_KIND || typeof secretPayload !== "string" || typeof targetPublicKey !== "string") {
        throw new SecretStoreError("The sealed value is not in the expected form. Reload the page and save again.", "invalid_value");
      }
      const result = await (await provisioner()).importSecrets({
        organizationId: spaceId,
        secrets: [
          {
            name,
            secretPayload,
            targetPublicKey,
            encryptionSuite: ENCLAVE_ENCRYPT_V1,
            staticProperties: Object.entries(labels).map(([key, value]) => ({ key, value })),
          },
        ],
      });
      if (!result.secretIds?.[0]) throw new Error("Turnkey returned no secret id");
    },

    async remove(spaceId, name) {
      const secretId = await findId(spaceId, name);
      if (!secretId) return false;
      await (await provisioner()).deleteSecrets({ organizationId: spaceId, secretIds: [secretId] });
      return true;
    },

    async read(spaceId, name, context) {
      const secretId = await findId(spaceId, name);
      if (!secretId) return null;
      return exportById(spaceId, secretId, context);
    },

    async readById(spaceId, secretId, context) {
      return exportById(spaceId, secretId, context);
    },
  };

  async function exportById(spaceId: string, secretId: string, context: Record<string, string>): Promise<string> {
    try {
      return await (await broker()).exportSecret({ organizationId: spaceId, secretId, requestContext: { ...context } });
    } catch (err) {
      // A policy that requires approval, or one that does not match the
      // request context, parks the export. Valet does not wait for
      // approvals, so name the cause instead of the generic provider error.
      if (err instanceof Error && "code" in err && (err.code === EXPORT_NEEDS_APPROVAL || err.code === PERMISSION_DENIED)) {
        throw new SecretStoreError(
          "Turnkey did not allow this export. Either a rule needs an approval, or this session may not read the secret. Check the secret's scope, then run again.",
          "forbidden",
        );
      }
      throw err;
    }
  }
}
