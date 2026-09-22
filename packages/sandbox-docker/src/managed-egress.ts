import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { MANAGED_EGRESS_CONTRACT_VERSION, ManagedEgressPrerequisiteError, validateManagedEgressRequest, type ManagedEgressRequest } from "@valet/engine";

export const HEMATITE_COMPATIBLE_SOURCE_COMMIT = "35cdd0bc8816afefb4012ba2f9ca66b927c1aa00" as const;
export const HEMATITE_COMPATIBLE_CONFIG_CONTRACT = "v1" as const;

const OWNER_LABEL = "valet.dev/managed-egress-owner";
const KIND_LABEL = "valet.dev/managed-egress-resource";
const CONTRACT_LABEL = "valet.dev/managed-egress-contract";

export interface DockerManagedEgressConfig {
  proxyArtifact: string;
  callbackUrl: string;
  listenerPort: number;
}

export type DockerResourceKind = "container" | "network" | "volume";

export interface DockerManagedEgressRuntime {
  inspect(kind: DockerResourceKind, name: string): Promise<Record<string, string> | null>;
  /** Runs one Docker command. Missing resources on delete or disconnect must be treated as success. */
  run(args: string[], stdin?: string): Promise<void>;
}

interface DockerCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function dockerCommand(args: string[], stdin?: string): Promise<DockerCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

function missingDockerResource(message: string): boolean {
  return /no such (container|network|volume)|network .* not found|is not connected to network|not connected/i.test(message);
}

function labelsRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((entry) => typeof entry === "string");
}

/** Docker CLI adapter. It never places stdin content in argv, environment, or errors. */
export function dockerManagedEgressCliRuntime(): DockerManagedEgressRuntime {
  return {
    async inspect(kind, name) {
      const result = await dockerCommand([kind, "inspect", "--format", "{{json .Config.Labels}}", name]);
      if (result.exitCode !== 0 && kind !== "container") {
        const retry = await dockerCommand([kind, "inspect", "--format", "{{json .Labels}}", name]);
        if (retry.exitCode !== 0) {
          if (missingDockerResource(retry.stderr)) return null;
          throw new Error(`docker ${kind} inspect failed. Check the Docker daemon before retrying. ${retry.stderr.trim()}`);
        }
        const parsed: unknown = JSON.parse(retry.stdout);
        if (!labelsRecord(parsed)) throw new Error(`docker ${kind} inspect returned invalid labels. Check the Docker daemon before retrying.`);
        return parsed;
      }
      if (result.exitCode !== 0) {
        if (missingDockerResource(result.stderr)) return null;
        throw new Error(`docker ${kind} inspect failed. Check the Docker daemon before retrying. ${result.stderr.trim()}`);
      }
      const parsed: unknown = JSON.parse(result.stdout);
      if (!labelsRecord(parsed)) throw new Error(`docker ${kind} inspect returned invalid labels. Check the Docker daemon before retrying.`);
      return parsed;
    },
    async run(args, stdin) {
      const result = await dockerCommand(args, stdin);
      if (result.exitCode === 0 || missingDockerResource(result.stderr)) return;
      throw new Error(`docker command failed. Check the Docker daemon before retrying. ${result.stderr.trim() || result.stdout.trim()}`);
    },
  };
}

export interface DockerManagedEgressPlan {
  internalNetwork: string;
  outboundNetwork: string;
  proxyContainer: string;
  tokenVolume: string;
  configVolume: string;
  labels: {
    internalNetwork: Record<string, string>;
    outboundNetwork: Record<string, string>;
    proxy: Record<string, string>;
    tokenVolume: Record<string, string>;
    configVolume: Record<string, string>;
  };
  createInternalNetworkArgs: string[];
  createOutboundNetworkArgs: string[];
  createTokenVolumeArgs: string[];
  createConfigVolumeArgs: string[];
  workloadNetworkArgs: string[];
  proxyRunArgs: string[];
  connectProxyOutboundArgs: string[];
}

function pinnedArtifact(value: string): boolean {
  return /^[-./a-zA-Z0-9_:]+@sha256:[a-f0-9]{64}$/.test(value);
}

export function validateDockerManagedEgressConfig(config: DockerManagedEgressConfig): void {
  if (!pinnedArtifact(config.proxyArtifact)) throw new ManagedEgressPrerequisiteError("configuration", "Managed egress proxy artifact is not digest-pinned. Set an OCI image with @sha256:<64 hex>.");
  let callback: URL;
  try { callback = new URL(config.callbackUrl); } catch { throw new ManagedEgressPrerequisiteError("callback", "Managed egress callback URL is invalid. Configure an HTTPS /v1/authorize URL."); }
  if (callback.protocol !== "https:" || callback.pathname !== "/v1/authorize" || callback.search || callback.hash || callback.username || callback.password) {
    throw new ManagedEgressPrerequisiteError("callback", "Managed egress callback must use HTTPS at exactly /v1/authorize with no user info, query, or fragment.");
  }
  if (!Number.isInteger(config.listenerPort) || config.listenerPort < 1 || config.listenerPort > 65535) throw new ManagedEgressPrerequisiteError("configuration", "Managed egress listener port is invalid. Configure a port from 1 through 65535.");
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function resourceName(prefix: string, proxyId: string): string {
  return `${prefix}-${digest(proxyId).slice(0, 16)}`;
}

function managedLabels(owner: string, resource: string): Record<string, string> {
  return {
    [OWNER_LABEL]: owner,
    [KIND_LABEL]: resource,
    [CONTRACT_LABEL]: MANAGED_EGRESS_CONTRACT_VERSION,
  };
}

function labelArgs(labels: Record<string, string>): string[] {
  return Object.entries(labels).flatMap(([key, value]) => ["--label", `${key}=${value}`]);
}

/** Pure topology. The callback identity never becomes a Docker resource name or label value. */
export function buildDockerManagedEgressPlan(config: DockerManagedEgressConfig, request: ManagedEgressRequest): DockerManagedEgressPlan {
  validateDockerManagedEgressConfig(config);
  validateManagedEgressRequest(request);
  const owner = digest(request.identity.proxyId);
  const internalNetwork = resourceName("valet-egress-internal", request.identity.proxyId);
  const outboundNetwork = resourceName("valet-egress-outbound", request.identity.proxyId);
  const proxyContainer = resourceName("valet-egress-proxy", request.identity.proxyId);
  const tokenVolume = resourceName("valet-egress-token", request.identity.proxyId);
  const configVolume = resourceName("valet-egress-config", request.identity.proxyId);
  const labels = {
    internalNetwork: managedLabels(owner, "internal-network"),
    outboundNetwork: managedLabels(owner, "outbound-network"),
    proxy: managedLabels(owner, "proxy"),
    tokenVolume: managedLabels(owner, "token-volume"),
    configVolume: managedLabels(owner, "config-volume"),
  };
  const proxyRunArgs = [
    "run", "-d", "--name", proxyContainer,
    "--network", internalNetwork,
    "--network-alias", "valet-egress-proxy",
    "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--mount", `type=volume,src=${tokenVolume},dst=/run/valet-egress,readonly`,
    "--mount", `type=volume,src=${configVolume},dst=/etc/hematite,readonly`,
    ...labelArgs(labels.proxy),
    config.proxyArtifact,
  ];
  return {
    internalNetwork,
    outboundNetwork,
    proxyContainer,
    tokenVolume,
    configVolume,
    labels,
    createInternalNetworkArgs: ["network", "create", "--internal", ...labelArgs(labels.internalNetwork), internalNetwork],
    createOutboundNetworkArgs: ["network", "create", ...labelArgs(labels.outboundNetwork), outboundNetwork],
    createTokenVolumeArgs: ["volume", "create", ...labelArgs(labels.tokenVolume), tokenVolume],
    createConfigVolumeArgs: ["volume", "create", ...labelArgs(labels.configVolume), configVolume],
    workloadNetworkArgs: ["--network", internalNetwork],
    proxyRunArgs,
    connectProxyOutboundArgs: ["network", "connect", outboundNetwork, proxyContainer],
  };
}

function owns(labels: Record<string, string>, expected: Record<string, string>): boolean {
  return Object.entries(expected).every(([key, value]) => labels[key] === value);
}

async function assertOwnedOrMissing(
  runtime: DockerManagedEgressRuntime,
  kind: DockerResourceKind,
  name: string,
  labels: Record<string, string>,
): Promise<boolean> {
  const observed = await runtime.inspect(kind, name);
  if (observed === null) return false;
  if (!owns(observed, labels)) {
    throw new ManagedEgressPrerequisiteError("cleanup", `Docker ${kind} ${name} is not owned by this managed egress topology. Remove the name collision before retrying.`);
  }
  return true;
}

/** Creates missing infrastructure and adopts only resources with the exact server-derived ownership labels. */
export async function applyDockerManagedEgressInfrastructure(
  plan: DockerManagedEgressPlan,
  runtime: DockerManagedEgressRuntime,
): Promise<void> {
  const resources: Array<{ kind: "network" | "volume"; name: string; labels: Record<string, string>; create: string[]; remove: string[] }> = [
    { kind: "network", name: plan.internalNetwork, labels: plan.labels.internalNetwork, create: plan.createInternalNetworkArgs, remove: ["network", "rm", plan.internalNetwork] },
    { kind: "network", name: plan.outboundNetwork, labels: plan.labels.outboundNetwork, create: plan.createOutboundNetworkArgs, remove: ["network", "rm", plan.outboundNetwork] },
    { kind: "volume", name: plan.tokenVolume, labels: plan.labels.tokenVolume, create: plan.createTokenVolumeArgs, remove: ["volume", "rm", "-f", plan.tokenVolume] },
    { kind: "volume", name: plan.configVolume, labels: plan.labels.configVolume, create: plan.createConfigVolumeArgs, remove: ["volume", "rm", "-f", plan.configVolume] },
  ];
  const created: typeof resources = [];
  try {
    for (const resource of resources) {
      if (!await assertOwnedOrMissing(runtime, resource.kind, resource.name, resource.labels)) {
        await runtime.run(resource.create);
        created.push(resource);
      }
    }
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const resource of created.reverse()) {
      await runtime.run(resource.remove).catch(() => { rollbackFailures.push(resource.name); });
    }
    if (rollbackFailures.length > 0) {
      throw new ManagedEgressPrerequisiteError("cleanup", `Docker managed egress setup failed and rollback left resources: ${rollbackFailures.join(", ")}. Remove them before retrying.`);
    }
    throw error;
  }
}

/** Disconnects the workload before ordered, ownership-checked, idempotent resource removal. */
export async function cleanupDockerManagedEgress(
  plan: DockerManagedEgressPlan,
  workloadContainer: string,
  runtime: DockerManagedEgressRuntime,
): Promise<void> {
  const internalExists = await assertOwnedOrMissing(runtime, "network", plan.internalNetwork, plan.labels.internalNetwork);
  const outboundExists = await assertOwnedOrMissing(runtime, "network", plan.outboundNetwork, plan.labels.outboundNetwork);
  const proxyExists = await assertOwnedOrMissing(runtime, "container", plan.proxyContainer, plan.labels.proxy);
  const tokenExists = await assertOwnedOrMissing(runtime, "volume", plan.tokenVolume, plan.labels.tokenVolume);
  const configExists = await assertOwnedOrMissing(runtime, "volume", plan.configVolume, plan.labels.configVolume);

  if (internalExists) await runtime.run(["network", "disconnect", "-f", plan.internalNetwork, workloadContainer]);
  if (proxyExists) await runtime.run(["rm", "-f", plan.proxyContainer]);
  if (tokenExists) await runtime.run(["volume", "rm", "-f", plan.tokenVolume]);
  if (configExists) await runtime.run(["volume", "rm", "-f", plan.configVolume]);
  if (outboundExists) await runtime.run(["network", "rm", plan.outboundNetwork]);
  if (internalExists) await runtime.run(["network", "rm", plan.internalNetwork]);
}
