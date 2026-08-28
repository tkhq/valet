/**
 * Pluggable workspace persistence: the `WorkspaceStore` contract every
 * backend implements, plus the shared object-key layout and the `none`
 * backend (docs/specs/2026-08-28-workspace-persistence-design.md, Parts 01
 * and 03).
 *
 * This module is pure — no I/O, no node builtins at runtime (the
 * `NodeJS.ReadableStream` references are type-only), so it is safe to export
 * from the engine barrel (the barrel must stay browser-safe; see the
 * skills-directory precedent). Concrete backends with real dependencies
 * (the S3 object-store backend) live next to the provider that wires them
 * (`packages/sandbox-kubernetes`), not here.
 */

/** Identifies one workspace across sandbox iterations (spec Part 01).
 * `workspaceId` is stable per logical workspace: the kubernetes wiring
 * passes the sandbox CR name (the deterministic `sandboxCrName(workspace)`
 * output), which the same principal reopening the same workspace always
 * reproduces. `ownerId` is the session's `userId`. */
export interface WorkspaceRef {
  orgId: string;
  ownerId: string;
  workspaceId: string;
}

export interface CheckpointManifest {
  /** Opaque, backend-assigned, unique per commit. */
  checkpointId: string;
  /** Stamped by the caller's clock, informative. */
  createdAtMs: number;
  sizeBytes: number;
  entryCount: number;
}

export interface WorkspaceStore {
  /** Resolve the latest committed checkpoint, or null when none exists. */
  latest(ref: WorkspaceRef): Promise<CheckpointManifest | null>;

  /**
   * Stream a workspace tar into the store and commit it. Returns the
   * manifest. MUST commit atomically (INV-2): a reader never observes a
   * partially written checkpoint as the latest, and this method returns
   * only after the commit marker is durable.
   */
  checkpoint(
    ref: WorkspaceRef,
    tar: NodeJS.ReadableStream,
    meta: { createdAtMs: number },
  ): Promise<CheckpointManifest>;

  /**
   * Stream the latest committed checkpoint's tar out, or null when none
   * exists. Resolves the same checkpoint `latest` reports at the same
   * instant.
   */
  restore(ref: WorkspaceRef): Promise<NodeJS.ReadableStream | null>;

  /**
   * Remove all checkpoints for a workspace. Called on explicit workspace
   * deletion, never on reap by default (spec Part 07).
   */
  purge(ref: WorkspaceRef): Promise<void>;
}

/** The closed set of backend names (INV-5: selection validates against
 * this enum and boot fails on an unknown value). */
export const WORKSPACE_PERSISTENCE_BACKENDS = ["object-store", "rwx-volume", "none"] as const;
export type WorkspacePersistenceBackend = (typeof WORKSPACE_PERSISTENCE_BACKENDS)[number];

/**
 * Validates a `WorkspaceRef` for use as an object-key namespace (INV-3).
 * Every segment must be non-empty, and must not contain `/` or whitespace —
 * an embedded `/` would let one workspace's key prefix contain another's
 * (`a` vs `a/b`), turning a purge of one workspace into a cross-workspace
 * delete. Throws with the offending field named.
 */
export function validateWorkspaceRef(ref: WorkspaceRef): void {
  for (const field of ["orgId", "ownerId", "workspaceId"] as const) {
    const value = ref[field];
    if (value === "") {
      throw new Error(`WorkspaceRef.${field} must not be empty`);
    }
    if (/[/\s]/.test(value)) {
      throw new Error(
        `WorkspaceRef.${field} must not contain "/" or whitespace, got ${JSON.stringify(value)}`,
      );
    }
  }
}

/** `<orgId>/<ownerId>/<workspaceId>` — the tenant-scoped key segment every
 * backend derives object keys from (spec Part 04). Validates the ref. */
export function workspaceKey(ref: WorkspaceRef): string {
  validateWorkspaceRef(ref);
  return `${ref.orgId}/${ref.ownerId}/${ref.workspaceId}`;
}

/**
 * Object-key layout under the bucket (spec Part 04). `prefix` is the
 * optional operator-configured extra key prefix ("" for none). These are
 * shared by the Node-side S3 backend AND the in-pod checkpoint/restore
 * scripts, so both write and read the identical layout.
 */
export function checkpointDataKey(prefix: string, ref: WorkspaceRef, checkpointId: string): string {
  return `${joinPrefix(prefix, ref)}/checkpoints/${checkpointId}/data.tar.gz`;
}

export function checkpointManifestKey(prefix: string, ref: WorkspaceRef, checkpointId: string): string {
  return `${joinPrefix(prefix, ref)}/checkpoints/${checkpointId}/manifest.json`;
}

/** The commit pointer: its body is the committed checkpointId. */
export function latestPointerKey(prefix: string, ref: WorkspaceRef): string {
  return `${joinPrefix(prefix, ref)}/latest`;
}

/** The whole-workspace prefix, for purge/list. Ends with "/". */
export function workspaceObjectPrefix(prefix: string, ref: WorkspaceRef): string {
  return `${joinPrefix(prefix, ref)}/`;
}

function joinPrefix(prefix: string, ref: WorkspaceRef): string {
  const key = workspaceKey(ref);
  return prefix === "" ? key : `${prefix.replace(/\/+$/, "")}/${key}`;
}

/**
 * Derived directories excluded from every checkpoint tar so checkpoints
 * stay small and restores stay fast (spec Appendix C). Rebuildable state
 * only — never source, never `.git`.
 */
export const DEFAULT_CHECKPOINT_IGNORE = [
  "node_modules",
  ".pnpm-store",
  ".npm",
  ".cache",
  ".venv",
  "__pycache__",
] as const;

/**
 * The `none` backend (spec Part 03): a no-op store for local development
 * and for operators who accept a fully ephemeral workspace. `latest` and
 * `restore` report nothing, `checkpoint` commits nothing.
 */
export class NoneWorkspaceStore implements WorkspaceStore {
  async latest(): Promise<CheckpointManifest | null> {
    return null;
  }

  async checkpoint(
    _ref: WorkspaceRef,
    _tar: NodeJS.ReadableStream,
    meta: { createdAtMs: number },
  ): Promise<CheckpointManifest> {
    return { checkpointId: "none", createdAtMs: meta.createdAtMs, sizeBytes: 0, entryCount: 0 };
  }

  async restore(): Promise<NodeJS.ReadableStream | null> {
    return null;
  }

  async purge(): Promise<void> {}
}
