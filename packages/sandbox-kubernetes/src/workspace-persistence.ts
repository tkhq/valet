/**
 * Resolved workspace-persistence configuration for the kubernetes provider
 * (workspace-persistence spec, Parts 05 and 07). The api's instance-config
 * parser validates the operator's `workspacePersistence` block (INV-5:
 * closed backend enum, boot fails on an unknown value) and hands the
 * provider this already-resolved shape.
 *
 * When `K8sProviderConfig.workspacePersistence` is absent entirely, the
 * provider keeps the legacy behavior: a ReadWriteOnce workspace PVC and no
 * checkpoint/restore. This deviates from the spec's "default object-store"
 * so an existing deploy does not flip storage models (or fail boot on a
 * missing bucket) before the operator provisions one. The spec document's
 * Deviations section records this; the api parser still defaults
 * `backend: object-store` whenever the block is present.
 */
import type { WorkspacePersistenceBackend } from "@valet/engine";

export interface ObjectStoreConfig {
  bucket: string;
  /** Empty string selects AWS S3 (`https://s3.<region>.amazonaws.com`).
   * Set for MinIO / R2 / GCS-interop (INV-4). */
  endpoint: string;
  region: string;
  /** Optional extra key prefix under the bucket ("" for none). */
  prefix: string;
  /** Name of the Kubernetes Secret (in the sandbox namespace) holding
   * `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, mounted into the
   * restore init container only — never into the main container (INV-6). */
  credentialsSecret: string;
  gzip: boolean;
  /** Committed checkpoints beyond the newest N are pruned after a
   * successful commit. */
  keepCheckpoints: number;
}

export interface RwxVolumeConfig {
  storageClassName: string;
}

export interface WorkspacePolicySettings {
  minCheckpointIntervalMs: number;
  checkpointOnReap: boolean;
  periodicCheckpoint: boolean;
  onRestoreFailure: "fallback" | "block";
}

export interface WorkspacePersistenceConfig {
  backend: WorkspacePersistenceBackend;
  /** Required when backend === "object-store". */
  objectStore?: ObjectStoreConfig;
  /** Required when backend === "rwx-volume". */
  rwxVolume?: RwxVolumeConfig;
  policy: WorkspacePolicySettings;
}

export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicySettings = {
  minCheckpointIntervalMs: 5 * 60_000,
  checkpointOnReap: true,
  periodicCheckpoint: true,
  onRestoreFailure: "fallback",
};

/** The effective S3 base URL: the configured endpoint, or the AWS regional
 * endpoint when the operator set none. Object URLs are path-style
 * (`<base>/<bucket>/<key>`) so one code path serves AWS and MinIO. */
export function objectStoreBaseUrl(cfg: Pick<ObjectStoreConfig, "endpoint" | "region">): string {
  if (cfg.endpoint !== "") return cfg.endpoint.replace(/\/+$/, "");
  return `https://s3.${cfg.region}.amazonaws.com`;
}
