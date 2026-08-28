/**
 * In-pod shell scripts for the object-store backend (workspace-persistence
 * spec, Part 05). Pure string builders — unit-testable without a cluster,
 * and runnable inside a plain container against MinIO by the integration
 * suite, so the REAL data path gets exercised outside kubernetes.
 *
 * Data-path design (spec 05.3: "the data path stays node to object store
 * and never transits the api"):
 *
 * - CHECKPOINT: the api presigns PUT URLs for `data.tar.gz`,
 *   `manifest.json`, and `latest`, then execs this script in the pod. The
 *   tar bytes flow pod → object store directly; the sandbox never holds
 *   bucket credentials (INV-3: a presigned URL is scoped to exactly one
 *   object key; INV-6: no credential to leak). Upload order data →
 *   manifest → latest is INV-2's commit ordering.
 *
 * - RESTORE: an init container (same image as the sandbox — already on the
 *   node) reads static credentials from a Secret volume and GETs with
 *   `curl --aws-sigv4`. Presigned GETs would not survive controller-driven
 *   pod recreation (the URL expires; a stale one would silently cold-start
 *   over INV-7's fallback), so restore uses real credentials — mounted
 *   into the init container ONLY, which exits before user code runs.
 *
 * Both scripts target /bin/sh (dash/busybox compatible: no pipefail, no
 * bashisms) and need only `curl` (>= 7.75 for --aws-sigv4) and `tar` in
 * the image.
 */
import { DEFAULT_CHECKPOINT_IGNORE } from "@valet/engine";
import { shQuote } from "./exec.js";

export const WORKSPACE_RESTORE_INIT_CONTAINER_NAME = "workspace-restore";
/** Mount path for the object-store credentials Secret inside the restore
 * init container. Outside /workspace, so a checkpoint tar can never
 * capture it (INV-6). */
export const WORKSPACE_STORE_CREDS_MOUNT_PATH = "/etc/valet/workspace-store";
export const WORKSPACE_STORE_VOLUME_NAME = "workspace-store-creds";

/** Env var names the restore init container receives (spec 05.2: the
 * WorkspaceRef fields and the object store config arrive as env).
 * Credentials are deliberately NOT env — they come from the Secret mount. */
export const RESTORE_ENV = {
  /** Path-style object base: `<endpoint>/<bucket>`. */
  baseUrl: "VALET_WS_BASE_URL",
  region: "VALET_WS_REGION",
  /** Full object-key prefix for this workspace, ending with "/" —
   * `workspaceObjectPrefix(prefix, ref)`. */
  workspacePrefix: "VALET_WS_PREFIX",
  onRestoreFailure: "VALET_WS_ON_RESTORE_FAILURE",
  orgId: "VALET_WS_ORG_ID",
  ownerId: "VALET_WS_OWNER_ID",
  workspaceId: "VALET_WS_WORKSPACE_ID",
} as const;

/**
 * The restore init container script (spec 05.2). Static text — all
 * per-workspace values arrive via `RESTORE_ENV` env vars on the init
 * container. Implements the `create` branch of the policy kernel in-shell:
 *   - /workspace non-empty → exit 0 without action (INV-1)
 *   - no committed checkpoint (404 on `latest`) → exit 0, cold start
 *   - otherwise download + extract the committed checkpoint
 * A failure exits 0 with /workspace emptied under `fallback`, non-zero
 * under `block` (INV-7).
 */
export function buildRestoreScript(): string {
  const sigv4 = `--aws-sigv4 "aws:amz:\${${RESTORE_ENV.region}}:s3" --user "$AK:$SK"`;
  return [
    `set -u`,
    `WS=/workspace`,
    // INV-1: restore only into an empty workspace.
    `if [ -n "$(ls -A "$WS" 2>/dev/null)" ]; then echo "workspace-restore: /workspace not empty; skipping restore (INV-1)"; exit 0; fi`,
    `AK=$(cat ${shQuote(`${WORKSPACE_STORE_CREDS_MOUNT_PATH}/AWS_ACCESS_KEY_ID`)}) || exit 1`,
    `SK=$(cat ${shQuote(`${WORKSPACE_STORE_CREDS_MOUNT_PATH}/AWS_SECRET_ACCESS_KEY`)}) || exit 1`,
    // Failure handling (INV-7): under "fallback" leave /workspace empty and
    // exit 0 so the main container cold-starts from the image; under
    // "block" exit non-zero so the pod fails to start.
    `fail() {`,
    `  echo "workspace-restore: $1. The sandbox starts from the baked image; check the object store config and credentials." >&2`,
    `  if [ "\${${RESTORE_ENV.onRestoreFailure}}" = "block" ]; then exit 1; fi`,
    `  rm -rf "$WS"/* "$WS"/.[!.]* "$WS"/..?* 2>/dev/null`,
    `  exit 0`,
    `}`,
    `BASE="\${${RESTORE_ENV.baseUrl}}/\${${RESTORE_ENV.workspacePrefix}}"`,
    `code=$(curl -s -o /tmp/ws-latest -w '%{http_code}' ${sigv4} "\${BASE}latest") || fail "latest pointer read failed (curl exit $?)"`,
    `if [ "$code" = "404" ]; then echo "workspace-restore: no committed checkpoint; cold start from image"; exit 0; fi`,
    `[ "$code" = "200" ] || fail "latest pointer read failed (http $code)"`,
    `CKPT=$(cat /tmp/ws-latest)`,
    // Never interpolate untrusted bucket content into a URL unvalidated.
    `case "$CKPT" in (*[!a-zA-Z0-9._-]*|"") fail "latest pointer holds an invalid checkpoint id";; esac`,
    `curl -sf -o /tmp/ws-data.tar.gz ${sigv4} "\${BASE}checkpoints/\${CKPT}/data.tar.gz" || fail "checkpoint download failed (curl exit $?)"`,
    `tar -xf /tmp/ws-data.tar.gz -C "$WS" || fail "checkpoint extract failed"`,
    `rm -f /tmp/ws-data.tar.gz /tmp/ws-latest`,
    `echo "workspace-restore: restored checkpoint $CKPT into /workspace"`,
  ].join("\n");
}

/** Presigned PUT URLs for one checkpoint commit, in INV-2 order. */
export interface CheckpointUploadUrls {
  dataUrl: string;
  manifestUrl: string;
  latestUrl: string;
}

export interface CheckpointScriptInput {
  checkpointId: string;
  createdAtMs: number;
  /** Directory names excluded from the tar (defaults to
   * DEFAULT_CHECKPOINT_IGNORE). */
  ignore?: readonly string[];
}

/**
 * The in-pod checkpoint script (spec 05.3). Tars /workspace (minus the
 * ignore list) to a temp file OUTSIDE /workspace, then uploads data →
 * manifest → latest via the presigned URLs (INV-2 ordering: `latest`
 * names a checkpoint only after its manifest exists). Prints a final
 * `checkpoint-committed size=<bytes> entries=<n>` line the provider
 * parses for metrics. Distinct exit codes name the failing step.
 *
 * The URLs are passed via env (not argv) so they never appear in a
 * process list; `execInPod` folds env through `export` statements inside
 * the composed shell command.
 */
export function buildCheckpointScript(input: CheckpointScriptInput): string {
  const ignore = input.ignore ?? DEFAULT_CHECKPOINT_IGNORE;
  const excludes = ignore.map((dir) => `--exclude=${shQuote(dir)}`).join(" ");
  return [
    `set -u`,
    `TMP=$(mktemp -d /tmp/valet-ckpt.XXXXXX) || exit 11`,
    `trap 'rm -rf "$TMP"' EXIT`,
    // GNU tar exits 1 for "file changed as we read it" — expected on a
    // live workspace and the archive is still valid; only >1 is fatal.
    `tar -czf "$TMP/data.tar.gz" ${excludes} -C /workspace .; rc=$?; [ "$rc" -le 1 ] || exit 12`,
    `SIZE=$(wc -c < "$TMP/data.tar.gz" | tr -d ' ')`,
    `COUNT=$(tar -tzf "$TMP/data.tar.gz" | grep -cv '^\\./$')`,
    `curl -sf -X PUT --upload-file "$TMP/data.tar.gz" "$VALET_WS_DATA_URL" || exit 13`,
    `printf '{"checkpointId":"%s","createdAtMs":%s,"sizeBytes":%s,"entryCount":%s}' ` +
      `${shQuote(input.checkpointId)} ${String(Math.floor(input.createdAtMs))} "$SIZE" "$COUNT" > "$TMP/manifest.json"`,
    `curl -sf -X PUT --upload-file "$TMP/manifest.json" "$VALET_WS_MANIFEST_URL" || exit 14`,
    `printf '%s' ${shQuote(input.checkpointId)} > "$TMP/latest"`,
    `curl -sf -X PUT --upload-file "$TMP/latest" "$VALET_WS_LATEST_URL" || exit 15`,
    `echo "checkpoint-committed size=$SIZE entries=$COUNT"`,
  ].join("\n");
}

/** Env the checkpoint script reads — see `buildCheckpointScript`. */
export function checkpointScriptEnv(urls: CheckpointUploadUrls): Record<string, string> {
  return {
    VALET_WS_DATA_URL: urls.dataUrl,
    VALET_WS_MANIFEST_URL: urls.manifestUrl,
    VALET_WS_LATEST_URL: urls.latestUrl,
  };
}

/** Parses the checkpoint script's final committed line. Null when the
 * output does not contain one (the script failed before commit). */
export function parseCheckpointResult(stdout: string): { sizeBytes: number; entryCount: number } | null {
  const match = /checkpoint-committed size=(\d+) entries=(\d+)/.exec(stdout);
  if (!match) return null;
  return { sizeBytes: Number(match[1]), entryCount: Number(match[2]) };
}
