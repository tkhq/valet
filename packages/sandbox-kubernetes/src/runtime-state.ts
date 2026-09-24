import { createHash } from "node:crypto";
import type * as k8s from "@kubernetes/client-node";
export const RUNTIME_STATE_ANNOTATION = "valet.dev/runtime-state-claim";
const SESSION_OWNER = "valet.dev/runtime-session";
const SANDBOX_OWNER = "valet.dev/runtime-sandbox";
export interface RuntimeStateClaim {
  apiVersion?: string;
  kind?: string;
  metadata: {
    name: string;
    labels?: Record<string, string>;
    annotations?: Record<string, string>;
    ownerReferences?: {
      uid: string;
      name: string;
      kind: string;
      apiVersion: string;
    }[];
  };
  spec?: {
    accessModes?: string[];
    resources?: { requests?: Record<string, string> };
  };
}
export interface RuntimeStateApi {
  read(namespace: string, name: string): Promise<RuntimeStateClaim | undefined>;
  create(namespace: string, claim: RuntimeStateClaim): Promise<void>;
  list(namespace: string, sandboxId?: string): Promise<RuntimeStateClaim[]>;
  delete(namespace: string, name: string): Promise<void>;
}
export function runtimeStateClaimName(sessionId: string): string {
  return `valet-runtime-${createHash("sha256").update(sessionId).digest("hex").slice(0, 32)}`;
}
function code(error: unknown): number | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "number"
    ? error.code
    : undefined;
}
function fromPvc(pvc: k8s.V1PersistentVolumeClaim): RuntimeStateClaim {
  if (!pvc.metadata?.name)
    throw new Error(
      "Runtime state claim has no identity. Inspect the Kubernetes claim before retrying.",
    );
  return {
    metadata: {
      name: pvc.metadata.name,
      labels: pvc.metadata.labels,
      annotations: pvc.metadata.annotations,
      ownerReferences: pvc.metadata.ownerReferences,
    },
    spec: pvc.spec,
  };
}
export function sandboxRuntimeStateApiAdapter(
  api: k8s.CoreV1Api,
): RuntimeStateApi {
  return {
    async read(namespace, name) {
      try {
        return fromPvc(
          await api.readNamespacedPersistentVolumeClaim({ namespace, name }),
        );
      } catch (error) {
        if (code(error) === 404) return undefined;
        throw error;
      }
    },
    async create(namespace, body) {
      await api.createNamespacedPersistentVolumeClaim({ namespace, body });
    },
    async list(namespace, sandboxId) {
      const result = await api.listNamespacedPersistentVolumeClaim({
        namespace,
        labelSelector:
          sandboxId === undefined
            ? SANDBOX_OWNER
            : `${SANDBOX_OWNER}=${sandboxId}`,
      });
      return result.items.map(fromPvc);
    },
    async delete(namespace, name) {
      try {
        await api.deleteNamespacedPersistentVolumeClaim({ namespace, name });
      } catch (error) {
        if (code(error) !== 404) throw error;
      }
    },
  };
}
/** No CR owner reference: replacement can remove an old CR without deleting this session's profile. */
export async function ensureRuntimeState(
  api: RuntimeStateApi,
  namespace: string,
  sessionId: string,
  sandboxId: string,
  storage: string,
  requireExisting: boolean,
): Promise<string> {
  const name = runtimeStateClaimName(sessionId);
  let existing = await api.read(namespace, name);
  if (!existing) {
    if (requireExisting)
      throw new Error(
        "The retained browser state volume is missing. Restore the session volume before adopting this sandbox.",
      );
    const claim: RuntimeStateClaim = {
      apiVersion: "v1",
      kind: "PersistentVolumeClaim",
      metadata: {
        name,
        labels: { [SANDBOX_OWNER]: sandboxId },
        annotations: { [SESSION_OWNER]: sessionId },
      },
      spec: {
        accessModes: ["ReadWriteOnce"],
        resources: { requests: { storage } },
      },
    };
    try {
      await api.create(namespace, claim);
      existing = claim;
    } catch (error) {
      if (code(error) !== 409) throw error;
      existing = await api.read(namespace, name);
    }
  }
  if (
    !existing ||
    existing.metadata.annotations?.[SESSION_OWNER] !== sessionId ||
    existing.metadata.labels?.[SANDBOX_OWNER] !== sandboxId ||
    existing.metadata.ownerReferences?.length
  )
    throw new Error(
      "Browser runtime volume has another owner. Stop the previous owner and restore the matching session volume before retrying.",
    );
  return name;
}
/** Private volumes retain their session identity after the Sandbox CR is deleted. */
export async function listRuntimeStateOwners(
  api: RuntimeStateApi,
  namespace: string,
  sandboxId?: string,
): Promise<{ sandboxId: string; sessionId: string }[]> {
  const owners: { sandboxId: string; sessionId: string }[] = [];
  for (const claim of await api.list(namespace, sandboxId)) {
    const sessionId = claim.metadata.annotations?.[SESSION_OWNER];
    const owner = claim.metadata.labels?.[SANDBOX_OWNER];
    if (
      !sessionId ||
      !owner ||
      (sandboxId !== undefined && owner !== sandboxId) ||
      claim.metadata.name !== runtimeStateClaimName(sessionId) ||
      claim.metadata.ownerReferences?.length
    )
      throw new Error(
        "Runtime state ownership is invalid. Inspect the claim before changing this session.",
      );
    owners.push({ sandboxId: owner, sessionId });
  }
  return owners;
}
/** The final session deletion path is the only caller that removes private state. */
export async function deleteRuntimeState(
  api: RuntimeStateApi,
  namespace: string,
  sandboxId: string,
): Promise<void> {
  for (const owner of await listRuntimeStateOwners(api, namespace, sandboxId))
    await api.delete(namespace, runtimeStateClaimName(owner.sessionId));
}
