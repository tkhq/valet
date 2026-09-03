/**
 * On-demand workspace PVC growth (`Sandbox.growWorkspace`, workspace-fit
 * spec `docs/specs/2026-09-03-sandbox-workspace-fit-design.md`).
 *
 * The agent-sandbox controller provisions one PVC per entry in the Sandbox
 * CR's `volumeClaimTemplates`, named `<templateName>-<sandboxName>`
 * (verified against the vendored controller at v0.5.1:
 * `controllers/sandbox_controller.go`'s `reconcilePVCs` — it also proves an
 * existing owned PVC is left untouched, `resourceOwnedBySandbox: no action
 * needed`, so patching the claim's storage request never fights the
 * controller). The workspace claim is therefore `workspace-<crName>`.
 *
 * Growth policy: double the current request, capped at a configured max.
 * A PVC cannot shrink, so every grow is one-way — the cap is the bound on
 * what a runaway workload can accrete. Expansion requires the StorageClass
 * to set `allowVolumeExpansion: true` (gp3 on the reference deploy does,
 * and expands ONLINE — no pod restart); on a class without it the patch is
 * rejected by the API server and the grow reports `grown: false`.
 *
 * Rate limit: EBS allows roughly one volume modification per 6 hours; a
 * second resize inside that window fails at the CSI layer and can
 * retry-storm. The last grow time is stamped as a PVC annotation (survives
 * api restarts) and a grow inside the cooldown is refused with a clear
 * reason instead of attempted.
 */
import type * as k8s from "@kubernetes/client-node";
import { setHeaderOptions } from "@kubernetes/client-node";
import type { WorkspaceGrowth } from "@valet/engine";
import { WORKSPACE_VOLUME_NAME } from "./manifest.js";

/** Annotation stamped on the PVC at each grow — the rate-limit record. */
export const WORKSPACE_GROW_ANNOTATION = "valet.dev/workspace-grow-at";

/** Minimum time between grows of one PVC. EBS allows ~one modification per
 * volume per 6 hours; a second inside the window fails at the CSI layer. */
export const WORKSPACE_GROW_COOLDOWN_MS = 6 * 3_600_000;

/** Fallback grow cap when `K8sProviderConfig.workspaceStorageMax` is unset. */
export const DEFAULT_WORKSPACE_STORAGE_MAX = "20Gi";

/** How long a grow waits for the resized capacity to land before giving up
 * (gp3 online expansion typically completes in well under a minute). */
const RESIZE_WAIT_TIMEOUT_MS = 120_000;
const RESIZE_POLL_INTERVAL_MS = 2_000;

/** The workspace PVC's name for a Sandbox CR (controller convention:
 * `<templateName>-<sandboxName>`). */
export function workspacePvcName(crName: string): string {
  return `${WORKSPACE_VOLUME_NAME}-${crName}`;
}

/** The PVC fields growth reads. `requestedStorage` is
 * `spec.resources.requests.storage`; `capacityStorage` is
 * `status.capacity.storage` (what the volume actually provides now). */
export interface WorkspacePvcRead {
  requestedStorage?: string;
  capacityStorage?: string;
  annotations: Record<string, string>;
}

/** Narrow interface over CoreV1Api for workspace PVC growth. */
export interface SandboxPvcApi {
  /** Read the PVC, or null on 404. */
  readPvc(namespace: string, name: string): Promise<WorkspacePvcRead | null>;
  /** Merge-patch the PVC's storage request and merge in `annotations`. */
  patchPvcStorage(
    namespace: string,
    name: string,
    storage: string,
    annotations: Record<string, string>,
  ): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNotFoundError(err: unknown): boolean {
  return isRecord(err) && typeof err.code === "number" && err.code === 404;
}

/** Wraps a real `k8s.CoreV1Api` instance. */
export function sandboxPvcApiAdapter(api: k8s.CoreV1Api): SandboxPvcApi {
  return {
    async readPvc(namespace, name) {
      try {
        const pvc = await api.readNamespacedPersistentVolumeClaim({ name, namespace });
        return {
          requestedStorage: pvc.spec?.resources?.requests?.["storage"],
          capacityStorage: pvc.status?.capacity?.["storage"],
          annotations: pvc.metadata?.annotations ?? {},
        };
      } catch (err) {
        if (isNotFoundError(err)) return null;
        throw err;
      }
    },
    async patchPvcStorage(namespace, name, storage, annotations) {
      await api.patchNamespacedPersistentVolumeClaim(
        {
          name,
          namespace,
          body: {
            metadata: { annotations },
            spec: { resources: { requests: { storage } } },
          },
        },
        setHeaderOptions("Content-Type", "application/merge-patch+json"),
      );
    },
  };
}

// ── Quantity math ─────────────────────────────────────────────────────

const BINARY_SUFFIXES: Record<string, number> = {
  Ki: 2 ** 10,
  Mi: 2 ** 20,
  Gi: 2 ** 30,
  Ti: 2 ** 40,
};

const DECIMAL_SUFFIXES: Record<string, number> = {
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
};

/**
 * Parses a Kubernetes storage quantity ("1Gi", "500Mi", "2G", "1073741824")
 * to bytes, or null when unparseable. Covers the suffixes storage values
 * realistically use (binary Ki/Mi/Gi/Ti, decimal k/M/G/T, plain bytes) —
 * not the full quantity grammar (no milli/exponent forms, which are
 * nonsensical for a PVC size).
 */
export function parseStorageQuantity(quantity: string): number | null {
  const match = /^([0-9]+(?:\.[0-9]+)?)(Ki|Mi|Gi|Ti|k|M|G|T)?$/.exec(quantity.trim());
  if (!match) return null;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = match[2];
  const unit = suffix ? (BINARY_SUFFIXES[suffix] ?? DECIMAL_SUFFIXES[suffix]) : 1;
  return Math.floor(value * unit);
}

/** Formats bytes as the largest binary suffix that divides evenly (else
 * plain bytes) — the doubles of any whole-Mi quantity stay whole. */
export function formatStorageQuantity(bytes: number): string {
  for (const [suffix, unit] of [
    ["Gi", 2 ** 30],
    ["Mi", 2 ** 20],
    ["Ki", 2 ** 10],
  ] as const) {
    if (bytes % unit === 0) return `${bytes / unit}${suffix}`;
  }
  return `${bytes}`;
}

// ── Growth ────────────────────────────────────────────────────────────

export interface GrowWorkspacePvcOpts {
  namespace: string;
  /** The Sandbox CR name (== `Sandbox.id`). */
  crName: string;
  /** Grow cap (quantity string). Default `DEFAULT_WORKSPACE_STORAGE_MAX`. */
  maxStorage?: string;
  /** Injectable clock/sleep for tests. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  resizeWaitTimeoutMs?: number;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function refused(reason: string, from?: string): WorkspaceGrowth {
  return { grown: false, reason, ...(from ? { from } : {}) };
}

/**
 * Grows the workspace PVC one increment (double, capped at `maxStorage`)
 * and waits for the resized capacity to land. Returns — never throws — a
 * `WorkspaceGrowth` whose `reason` names why a refused grow was refused;
 * API-server errors from the read/patch DO propagate (the caller treats a
 * thrown error as `error`, distinct from a policy refusal).
 */
export async function growWorkspacePvc(api: SandboxPvcApi, opts: GrowWorkspacePvcOpts): Promise<WorkspaceGrowth> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? defaultSleep;
  const pvcName = workspacePvcName(opts.crName);
  const maxQuantity = opts.maxStorage ?? DEFAULT_WORKSPACE_STORAGE_MAX;

  const pvc = await api.readPvc(opts.namespace, pvcName);
  if (pvc === null) {
    return refused(`workspace PVC ${pvcName} not found in namespace ${opts.namespace}`);
  }
  const current = pvc.requestedStorage;
  if (!current) {
    return refused(`workspace PVC ${pvcName} has no storage request`);
  }
  const currentBytes = parseStorageQuantity(current);
  if (currentBytes === null || currentBytes <= 0) {
    return refused(`workspace PVC ${pvcName} storage request "${current}" is not a parseable quantity`, current);
  }
  const maxBytes = parseStorageQuantity(maxQuantity);
  if (maxBytes === null || maxBytes <= 0) {
    return refused(`configured workspace storage max "${maxQuantity}" is not a parseable quantity`, current);
  }
  if (currentBytes >= maxBytes) {
    return refused(
      `workspace is already at the ${maxQuantity} growth cap (VALET_SANDBOX_WORKSPACE_MAX). ` +
        "Free space in the workspace, or raise the cap.",
      current,
    );
  }

  const lastGrowAt = Date.parse(pvc.annotations[WORKSPACE_GROW_ANNOTATION] ?? "");
  if (!Number.isNaN(lastGrowAt)) {
    const sinceMs = now() - lastGrowAt;
    if (sinceMs >= 0 && sinceMs < WORKSPACE_GROW_COOLDOWN_MS) {
      const remainingMin = Math.ceil((WORKSPACE_GROW_COOLDOWN_MS - sinceMs) / 60_000);
      return refused(
        `workspace was already grown recently; EBS allows one volume modification per ~6h. ` +
          `Retry in ~${remainingMin} minutes, or free space in the workspace.`,
        current,
      );
    }
  }

  const nextBytes = Math.min(currentBytes * 2, maxBytes);
  const next = nextBytes === maxBytes ? maxQuantity : formatStorageQuantity(nextBytes);
  await api.patchPvcStorage(opts.namespace, pvcName, next, {
    [WORKSPACE_GROW_ANNOTATION]: new Date(now()).toISOString(),
  });

  // Wait for the resize to actually land (gp3 expands online; the kubelet
  // grows the filesystem live and stamps status.capacity when done).
  const timeoutMs = opts.resizeWaitTimeoutMs ?? RESIZE_WAIT_TIMEOUT_MS;
  const deadline = now() + timeoutMs;
  for (;;) {
    const readBack = await api.readPvc(opts.namespace, pvcName);
    const capacityBytes = readBack?.capacityStorage ? parseStorageQuantity(readBack.capacityStorage) : null;
    if (capacityBytes !== null && capacityBytes >= nextBytes) {
      return { grown: true, from: current, to: next };
    }
    if (now() >= deadline) {
      return refused(
        `workspace resize ${current} → ${next} was requested but did not complete within ${Math.round(timeoutMs / 1000)}s. ` +
          "It may still complete in the background — retry the operation later. " +
          "If it never completes, check that the StorageClass allows volume expansion.",
        current,
      );
    }
    await sleep(RESIZE_POLL_INTERVAL_MS);
  }
}
