/**
 * Pure Sandbox CR name derivation + manifest construction (decision 5).
 *
 * No Kubernetes client calls happen in this module — it only builds plain
 * objects. Verified against the vendored agent-sandbox v0.5.1 CRD (see
 * ./types.ts docblock for the source URL and confirmed shape).
 */
import { createHash } from "node:crypto";
import type { SandboxCreateOpts } from "@valet/engine";
import type {
  K8sProviderConfig,
  ResourceList,
  SandboxContainer,
  SandboxCR,
} from "./types.js";

const MAX_NAME_LENGTH = 63;
const HASH_SUFFIX_LENGTH = 8;
const DEFAULT_STORAGE = "2Gi";

/** `full`-profile container command — starts the interactive services (ttyd,
 * code-server, auth gateway) instead of the bare `tail -f /dev/null`
 * placeholder. The image ENTRYPOINT is bypassed by this explicit `command`.
 * `/start-full.sh` is added to the image in Task 4; referenced here ahead of
 * that landing per the Task 3 brief. */
const FULL_PROFILE_COMMAND = ["/bin/bash", "/start-full.sh"];

export const WORKSPACE_VOLUME_NAME = "workspace";
export const WORKSPACE_MOUNT_PATH = "/workspace";
export const SESSION_LABEL_KEY = "valet.dev/session-id";
export const SANDBOX_CONTAINER_NAME = "sandbox";

/** Lowercases and strips everything outside `[a-z0-9-]`, collapsing runs of
 * dashes and trimming leading/trailing dashes. Does NOT enforce the length
 * bound — callers apply truncation + hash suffixing separately. */
function sanitizeToRfc1123Chars(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Short, deterministic hash of the original (pre-sanitization) input, used
 * as a collision-resistant suffix whenever truncation could otherwise make
 * two distinct inputs produce the same name. */
function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, HASH_SUFFIX_LENGTH);
}

/** Derives a deterministic, RFC1123-safe (lowercase alphanumeric + dashes,
 * no leading/trailing dash), <=63-char identifier from an arbitrary input
 * string (e.g. a session key like "orchestrator:user123"). When sanitization
 * or truncation would risk a collision, a hash suffix derived from the
 * original input is appended so that two inputs differing only past the
 * truncation point still resolve to distinct names. */
function deterministicRfc1123(input: string): string {
  const sanitized = sanitizeToRfc1123Chars(input);

  if (sanitized.length === 0) {
    return `x-${shortHash(input)}`;
  }

  if (sanitized.length <= MAX_NAME_LENGTH) {
    return sanitized;
  }

  const hash = shortHash(input);
  const budget = MAX_NAME_LENGTH - HASH_SUFFIX_LENGTH - 1; // 1 for the joining dash
  const truncated = sanitized.slice(0, budget).replace(/-+$/g, "");
  return `${truncated}-${hash}`;
}

/** Deterministic, RFC1123-safe Sandbox CR name for a session key. Two
 * distinct session keys that only diverge after the truncation point still
 * produce distinct names (collision resistance via the hash suffix). */
export function sandboxCrName(sessionKey: string): string {
  return deterministicRfc1123(sessionKey);
}

function resourceListFrom(resources: { cpu?: number; memory?: string }): ResourceList | undefined {
  const list: ResourceList = {};
  if (resources.cpu !== undefined) list.cpu = String(resources.cpu);
  if (resources.memory !== undefined) list.memory = resources.memory;
  return Object.keys(list).length > 0 ? list : undefined;
}

/**
 * Builds the Sandbox custom resource for a session. `name` is expected to
 * already be a valid CR name (typically the output of `sandboxCrName`); it
 * is reused as the `valet.dev/session-id` label value since it is already
 * RFC1123-safe and within the 63-char label-value bound.
 *
 * There is intentionally NO top-level image/env/resources field — those all
 * live inside `spec.podTemplate.spec` (a full corev1.PodSpec), matching the
 * real CRD shape (see ./types.ts).
 */
export function buildSandboxManifest(
  cfg: K8sProviderConfig,
  name: string,
  opts: SandboxCreateOpts,
): SandboxCR {
  const image = opts.image ?? cfg.defaultImage;
  const resourceOpts = opts.resources ?? cfg.defaultResources;
  const resourceList = resourceOpts ? resourceListFrom(resourceOpts) : undefined;

  const container: SandboxContainer = {
    name: SANDBOX_CONTAINER_NAME,
    image,
    // Non-terminating placeholder — mirrors sandbox-docker's
    // `sh -c "tail -f /dev/null"` idiom (packages/sandbox-docker/src/sandbox.ts).
    // The controller/exec surface does the actual work; this just keeps the
    // container's PID 1 alive.
    command: ["sh", "-c", "tail -f /dev/null"],
    volumeMounts: [{ name: WORKSPACE_VOLUME_NAME, mountPath: WORKSPACE_MOUNT_PATH }],
    // See SandboxContainer.workingDir's docblock (types.ts) — the k8s
    // pods/exec API has no per-call --workdir, so this container-level
    // default is what makes relative-path exec/file ops land on the
    // persistent /workspace volume instead of the ephemeral rootfs.
    workingDir: WORKSPACE_MOUNT_PATH,
  };

  if (opts.env && Object.keys(opts.env).length > 0) {
    container.env = Object.entries(opts.env).map(([envName, value]) => ({ name: envName, value }));
  }

  if (resourceList) {
    container.resources = { requests: resourceList, limits: resourceList };
  }

  const isFullProfile = opts.profile === "full";
  if (isFullProfile) {
    container.command = FULL_PROFILE_COMMAND;
  }

  const spec: SandboxCR["spec"] = {
    podTemplate: {
      spec: {
        containers: [container],
        restartPolicy: "Always",
      },
    },
    volumeClaimTemplates: [
      {
        metadata: { name: WORKSPACE_VOLUME_NAME },
        spec: {
          accessModes: ["ReadWriteOnce"],
          resources: {
            requests: { storage: cfg.defaultStorage ?? DEFAULT_STORAGE },
          },
        },
      },
    ],
  };
  if (isFullProfile) {
    spec.service = true;
  }

  return {
    apiVersion: cfg.apiVersion,
    kind: "Sandbox",
    metadata: {
      name,
      labels: { [SESSION_LABEL_KEY]: name },
    },
    spec,
  };
}
