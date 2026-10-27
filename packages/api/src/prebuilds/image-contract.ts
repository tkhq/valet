/**
 * Image runtime contract (image-pipeline-health design, section 5).
 *
 * `compatible` is the ONE predicate the scheduler's skip rule, the parent
 * readiness check, and the session-start resolvers share. `readImageContractLabel`
 * reads the `io.valet.sandbox.contract` OCI label from a pushed image: on the
 * kubernetes backend through the registry (manifest, then config blob, like
 * `bake-size.ts`), on the docker backend through `docker image inspect`.
 * Never throws; a failed read is `{ ok: false, error }` so the caller can mark
 * the source `contract_unknown` and retry on the next pass.
 */
import { MIN_IMAGE_CONTRACT } from "@valet/sandbox-kubernetes";
import type { SpawnFn } from "./docker-builder.js";
import { parseRegistryImageRef, MANIFEST_ACCEPT } from "./registry.js";
import { pushRefFor } from "./k8s-builder.js";

export const CONTRACT_LABEL = "io.valet.sandbox.contract";

export interface ContractFields {
  contractVersion: number | null;
  contractSource: string | null;
}

/** Spec 5.3. A missing row, a null contract on a non-override bake, or a
 * value below the minimum reads as incompatible. */
export function compatible(bake: ContractFields | null | undefined): boolean {
  if (!bake) return false;
  if (bake.contractSource === "override") return true;
  return bake.contractVersion !== null && bake.contractVersion >= MIN_IMAGE_CONTRACT;
}

export interface ContractReadDeps {
  fetchImpl: typeof fetch;
  spawnFn: SpawnFn;
  registryInsecure: boolean;
  registryPushHost?: string;
  /** Per-request budget; the post-push read is off the session path, so a
   * generous default is fine. */
  timeoutMs?: number;
}

export type ContractRead = { ok: true; version: number | null } | { ok: false; error: string };

const DEFAULT_TIMEOUT_MS = 10_000;

function parseContract(raw: unknown): number | null {
  if (typeof raw !== "string") return null;
  return /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : null;
}

function labelsOf(config: unknown): Record<string, unknown> | null {
  if (typeof config !== "object" || config === null) return null;
  const inner = (config as { config?: unknown }).config;
  if (typeof inner !== "object" || inner === null) return null;
  const labels = (inner as { Labels?: unknown }).Labels;
  return typeof labels === "object" && labels !== null ? (labels as Record<string, unknown>) : null;
}

async function readFromRegistry(imageRef: string, deps: ContractReadDeps): Promise<ContractRead> {
  const parsed = parseRegistryImageRef(pushRefFor(imageRef, deps.registryPushHost));
  if (!parsed) return { ok: false, error: `unparseable image ref ${imageRef}` };
  const { host, name, tag } = parsed;
  const scheme = deps.registryInsecure ? "http" : "https";
  const base = `${scheme}://${host}/v2/${name}`;
  const timeout = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const getJson = async (url: string, accept: string): Promise<unknown> => {
    const res = await deps.fetchImpl(url, { headers: { Accept: accept }, signal: AbortSignal.timeout(timeout) });
    if (!res.ok) throw new Error(`${url} responded ${res.status}`);
    return res.json();
  };
  try {
    let manifest = (await getJson(`${base}/manifests/${tag}`, MANIFEST_ACCEPT)) as Record<string, unknown>;
    // An OCI index (multi-arch) points at per-platform manifests; take the
    // first linux one, else the first entry. BuildKit pushes a plain
    // manifest by default, so this branch is rare here.
    if (Array.isArray(manifest["manifests"])) {
      const entries = manifest["manifests"] as Array<{ digest?: string; platform?: { os?: string } }>;
      const pick = entries.find((e) => e.platform?.os === "linux") ?? entries[0];
      if (!pick?.digest) return { ok: false, error: "image index has no manifests" };
      manifest = (await getJson(`${base}/manifests/${pick.digest}`, MANIFEST_ACCEPT)) as Record<string, unknown>;
    }
    const configDigest = (manifest["config"] as { digest?: unknown } | undefined)?.digest;
    if (typeof configDigest !== "string") return { ok: false, error: "manifest has no config digest" };
    const config = await getJson(`${base}/blobs/${configDigest}`, "application/json, */*");
    const labels = labelsOf(config);
    return { ok: true, version: parseContract(labels?.[CONTRACT_LABEL]) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function readFromDocker(imageRef: string, deps: ContractReadDeps): Promise<ContractRead> {
  return new Promise((resolve) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = deps.spawnFn("docker", ["image", "inspect", "--format", `{{index .Config.Labels "${CONTRACT_LABEL}"}}`, imageRef], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
    } catch (err) {
      resolve({ ok: false, error: err instanceof Error ? err.message : String(err) });
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (c: Buffer) => chunks.push(c));
    child.on("error", (err) => resolve({ ok: false, error: err.message }));
    child.on("close", (code) => {
      if (code !== 0) { resolve({ ok: false, error: `docker image inspect exited ${code}` }); return; }
      resolve({ ok: true, version: parseContract(Buffer.concat(chunks).toString("utf8").trim()) });
    });
  });
}

export async function readImageContractLabel(backend: string, imageRef: string, deps: ContractReadDeps): Promise<ContractRead> {
  try {
    if (backend === "kubernetes") return await readFromRegistry(imageRef, deps);
    if (backend === "docker") return await readFromDocker(imageRef, deps);
    return { ok: false, error: `no contract reader for backend ${backend}` };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
