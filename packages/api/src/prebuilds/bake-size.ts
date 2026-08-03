/**
 * Best-effort image size measurement at push time.
 *
 * - docker backend: `docker image inspect --format {{.Size}}` → bytes as number
 * - kubernetes backend: GET registry manifest, sum config.size + layers[].size
 * - Returns null on any failure — never throws.
 */
import type { SpawnFn } from "./docker-builder.js";
import { parseRegistryImageRef, MANIFEST_ACCEPT } from "./registry.js";
import { pushRefFor } from "./k8s-builder.js";

export interface BakeSizeDeps {
  spawnFn: SpawnFn;
  fetchImpl: typeof fetch;
  registryInsecure: boolean;
  registryPushHost?: string;
}

/** Docker manifest v2 + OCI image manifest shape — only the fields we need. */
interface ManifestSize {
  config: { size: number };
  layers: Array<{ size: number }>;
}

function isManifestSize(value: unknown): value is ManifestSize {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v["config"] !== "object" || v["config"] === null) return false;
  const cfg = v["config"] as Record<string, unknown>;
  if (typeof cfg["size"] !== "number") return false;
  if (!Array.isArray(v["layers"])) return false;
  for (const layer of v["layers"] as unknown[]) {
    if (typeof layer !== "object" || layer === null) return false;
    if (typeof (layer as Record<string, unknown>)["size"] !== "number") return false;
  }
  return true;
}

function measureDockerSize(imageRef: string, deps: BakeSizeDeps): Promise<number | null> {
  return new Promise((resolve) => {
    let child: ReturnType<SpawnFn>;
    try {
      child = deps.spawnFn("docker", ["image", "inspect", imageRef, "--format", "{{.Size}}"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
    } catch {
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", () => resolve(null));
    child.on("close", (code: number | null) => {
      if (code !== 0) {
        resolve(null);
        return;
      }
      const text = Buffer.concat(chunks).toString("utf8").trim();
      const n = parseInt(text, 10);
      resolve(Number.isFinite(n) ? n : null);
    });
  });
}

async function measureK8sSize(imageRef: string, deps: BakeSizeDeps): Promise<number | null> {
  const ref = pushRefFor(imageRef, deps.registryPushHost);
  const parsed = parseRegistryImageRef(ref);
  if (!parsed) return null;
  const { host, name, tag } = parsed;
  const scheme = deps.registryInsecure ? "http" : "https";
  let res: Response;
  try {
    res = await deps.fetchImpl(`${scheme}://${host}/v2/${name}/manifests/${tag}`, {
      headers: { Accept: MANIFEST_ACCEPT },
    });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return null;
  }
  if (!isManifestSize(body)) return null;
  return body.config.size + body.layers.reduce((sum, l) => sum + l.size, 0);
}

/**
 * Measures the compressed size of a pushed bake image.
 * - docker: `docker image inspect --format {{.Size}}`
 * - kubernetes: GET registry manifest, sum config + layer sizes
 * Returns null on any failure.
 */
export async function measureBakeSize(
  backend: string,
  imageRef: string,
  deps: BakeSizeDeps,
): Promise<number | null> {
  try {
    if (backend === "docker") return await measureDockerSize(imageRef, deps);
    if (backend === "kubernetes") return await measureK8sSize(imageRef, deps);
    return null;
  } catch {
    return null;
  }
}
