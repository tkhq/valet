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
   * `workspaceObjectPrefix(prefix, ref)`. All per-workspace identity the
   * script needs is already encoded in this prefix. */
  workspacePrefix: "VALET_WS_PREFIX",
  onRestoreFailure: "VALET_WS_ON_RESTORE_FAILURE",
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
    // Termination message: the provider reads it from the pod's
    // initContainerStatuses to record restore metrics and to refuse
    // checkpoints after a failed restore (the cold-start clobber guard in
    // maybeCheckpointWorkspace). Best-effort — the path is absent outside
    // kubernetes (the MinIO suite runs this script in a plain container).
    `note() { printf '%s' "$1" > /dev/termination-log 2>/dev/null || true; }`,
    // INV-1: restore only into an empty workspace.
    `if [ -n "$(ls -A "$WS" 2>/dev/null)" ]; then note "skipped reason=non-empty"; echo "workspace-restore: /workspace not empty; skipping restore (INV-1)"; exit 0; fi`,
    `AK=$(cat ${shQuote(`${WORKSPACE_STORE_CREDS_MOUNT_PATH}/AWS_ACCESS_KEY_ID`)}) || { note "failed reason=creds"; exit 1; }`,
    `SK=$(cat ${shQuote(`${WORKSPACE_STORE_CREDS_MOUNT_PATH}/AWS_SECRET_ACCESS_KEY`)}) || { note "failed reason=creds"; exit 1; }`,
    // Failure handling (INV-7): under "fallback" leave /workspace empty and
    // exit 0 so the main container cold-starts from the image; under
    // "block" exit non-zero so the pod fails to start.
    `fail() {`,
    `  echo "workspace-restore: $1. The sandbox starts from the baked image; check the object store config and credentials." >&2`,
    // :-fallback, despite set -u: a missing mode env must not invert
    // INV-7's default into an implicit "block".
    `  if [ "\${${RESTORE_ENV.onRestoreFailure}:-fallback}" = "block" ]; then note "failed"; exit 1; fi`,
    `  rm -rf "$WS"/* "$WS"/.[!.]* "$WS"/..?* 2>/dev/null`,
    `  note "cold-start reason=restore-failed"`,
    `  exit 0`,
    `}`,
    `BASE="\${${RESTORE_ENV.baseUrl}}/\${${RESTORE_ENV.workspacePrefix}}"`,
    `code=$(curl -s -o /tmp/ws-latest -w '%{http_code}' ${sigv4} "\${BASE}latest") || fail "latest pointer read failed (curl exit $?)"`,
    `if [ "$code" = "404" ]; then note "cold-start reason=no-checkpoint"; echo "workspace-restore: no committed checkpoint; cold start from image"; exit 0; fi`,
    // 403 hint: without s3:ListBucket, S3 answers 403 (not 404) for a GET
    // of a missing key — a new workspace then looks like a restore failure.
    `if [ "$code" = "403" ]; then fail "latest pointer read failed (http 403); if this workspace is new, grant the credential s3:ListBucket on the bucket (S3 returns 403, not 404, for a missing key without it)"; fi`,
    `[ "$code" = "200" ] || fail "latest pointer read failed (http $code)"`,
    `CKPT=$(cat /tmp/ws-latest)`,
    // Never interpolate untrusted bucket content into a URL unvalidated.
    `case "$CKPT" in (*[!a-zA-Z0-9._-]*|"") fail "latest pointer holds an invalid checkpoint id";; esac`,
    `curl -sf -o /tmp/ws-data.tar.gz ${sigv4} "\${BASE}checkpoints/\${CKPT}/data.tar.gz" || fail "checkpoint download failed (curl exit $?)"`,
    `tar -xf /tmp/ws-data.tar.gz -C "$WS" || fail "checkpoint extract failed"`,
    `rm -f /tmp/ws-data.tar.gz /tmp/ws-latest`,
    `note "restored checkpoint=$CKPT"`,
    `echo "workspace-restore: restored checkpoint $CKPT into /workspace"`,
  ].join("\n");
}

/** Restore outcome parsed from the init container's termination message. */
export type WorkspaceRestoreOutcome =
  | { kind: "restored"; checkpointId?: string }
  | { kind: "cold_start"; reason: "no-checkpoint" | "restore-failed" }
  | { kind: "failed" }
  | { kind: "skipped" };

/** Parses a `workspace-restore` termination message written by `note` in
 * `buildRestoreScript`. Null for an empty or unrecognized message (pods
 * predating this script, or a container that died before writing one). */
export function parseRestoreTerminationMessage(message: string): WorkspaceRestoreOutcome | null {
  const m = message.trim();
  if (m.startsWith("restored")) {
    const ck = /checkpoint=(\S+)/.exec(m)?.[1];
    return ck ? { kind: "restored", checkpointId: ck } : { kind: "restored" };
  }
  if (m.startsWith("cold-start")) {
    return {
      kind: "cold_start",
      reason: m.includes("reason=restore-failed") ? "restore-failed" : "no-checkpoint",
    };
  }
  if (m.startsWith("failed")) return { kind: "failed" };
  if (m.startsWith("skipped")) return { kind: "skipped" };
  return null;
}

/** In-pod marker whose mtime is the last committed checkpoint's tar-scan
 * start. Pod-local (/tmp): dies with the pod, so a fresh pod never skips. */
export const CHECKPOINT_MARKER_PATH = "/tmp/.valet-checkpoint-marker";

/** Stdout sentinel: the workspace has not changed since the last committed
 * checkpoint from this pod, so the script skipped the upload (exit 0). */
export const CHECKPOINT_UNCHANGED_SENTINEL = "checkpoint-unchanged";

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
  /** Gzip the archive (default true). MUST match the store config's
   * `gzip` — the Node-side `restore()` gunzips based on that flag. */
  gzip?: boolean;
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
  // The same ignore list feeds the change scan below — cache/dependency
  // writes alone must not force a full re-upload.
  const prunes = ignore.length
    ? `\\( ${ignore.map((dir) => `-name ${shQuote(dir)}`).join(" -o ")} \\) -prune -o `
    : "";
  // The z flag must track the store config's gzip setting: the Node-side
  // restore() gunzips only when the config says so (the k8s init container
  // is immune — `tar -xf` auto-detects).
  const z = input.gzip === false ? "" : "z";
  return [
    `set -u`,
    `MARKER=${shQuote(CHECKPOINT_MARKER_PATH)}`,
    `TMP=$(mktemp -d /tmp/valet-ckpt.XXXXXX) || exit 11`,
    `trap 'rm -rf "$TMP"' EXIT`,
    // Change detection: the marker's mtime is the scan-start time of the
    // last checkpoint this pod committed (see the `touch -r` below). If
    // nothing under /workspace is newer — deletes count too, they bump the
    // parent directory's mtime — the committed checkpoint already covers
    // the current state and the upload is skipped. The marker lives in
    // /tmp, so a fresh pod always takes a full checkpoint.
    `if [ -e "$MARKER" ] && [ -z "$(find /workspace ${prunes}-newer "$MARKER" -print 2>/dev/null | head -n 1)" ]; then echo "${CHECKPOINT_UNCHANGED_SENTINEL}"; exit 0; fi`,
    `touch "$TMP/started"`,
    // GNU tar exits 1 for "file changed as we read it" — expected on a
    // live workspace and the archive is still valid; only >1 is fatal.
    `tar -c${z}f "$TMP/data.tar.gz" ${excludes} -C /workspace .; rc=$?; [ "$rc" -le 1 ] || exit 12`,
    `SIZE=$(wc -c < "$TMP/data.tar.gz" | tr -d ' ')`,
    `COUNT=$(tar -t${z}f "$TMP/data.tar.gz" | grep -cv '^\\./$')`,
    `curl -sf -X PUT --upload-file "$TMP/data.tar.gz" "$VALET_WS_DATA_URL" || exit 13`,
    `printf '{"checkpointId":"%s","createdAtMs":%s,"sizeBytes":%s,"entryCount":%s}' ` +
      `${shQuote(input.checkpointId)} ${String(Math.floor(input.createdAtMs))} "$SIZE" "$COUNT" > "$TMP/manifest.json"`,
    `curl -sf -X PUT --upload-file "$TMP/manifest.json" "$VALET_WS_MANIFEST_URL" || exit 14`,
    `printf '%s' ${shQuote(input.checkpointId)} > "$TMP/latest"`,
    `curl -sf -X PUT --upload-file "$TMP/latest" "$VALET_WS_LATEST_URL" || exit 15`,
    // Marker mtime = tar scan start, not commit time: files written while
    // the upload ran stay newer than the marker and force the next pass.
    `touch -r "$TMP/started" "$MARKER"`,
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
