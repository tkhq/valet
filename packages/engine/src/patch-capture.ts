/**
 * Settle-time patch capture (engine traces spec, change 3): a best-effort
 * unified diff of the sandbox workspace against the session's start-ref,
 * stored through the BlobStore seam under the deterministic key
 * `patches/{sessionId}/{queueItemId}.diff`.
 *
 * Contract: NEVER throws — every path returns a `SettlePatchRef`; unexpected
 * exceptions are converted to `{ status: "failed" }` and logged. Runs out of
 * the settlement write-fence path, so a dead sandbox, a non-git workspace, or
 * a rejecting blob store degrade to skip/fail metadata without weakening the
 * reserve/finalize CAS.
 *
 * Untracked files use `git add -N` (intent-to-add): `git diff` then treats
 * them as additions without actually staging anything, and the trailing
 * `git reset -q` clears even the stubs so the workspace's git state after
 * capture is byte-identical to before. (`git add -A` would fully stage every
 * change; `git stash --include-untracked` mutates the reflog and races
 * concurrent git tools.)
 */
import type { BlobStore, Sandbox, SessionStartRef, SettlePatchRef } from "./types.js";

/** Uncompressed size cap. Head-only truncation with a trailing marker — a
 * truncated patch is still cross-checkable; rejecting a large diff would
 * throw away signal we can never recover. */
export const MAX_PATCH_BYTES = 2 * 1024 * 1024;

/** Per-exec timeout: patch capture happens once per settle and must never
 * hold the settle path hostage to a wedged sandbox. */
const EXEC_TIMEOUT_MS = 30_000;

export function patchBlobKey(sessionId: string, queueItemId: string): string {
  return `patches/${sessionId}/${queueItemId}.diff`;
}

export interface PatchCaptureContext {
  sessionId: string;
  queueItemId: string;
  /** The engine is optional-blob by design; absent → skipped. */
  blobs: BlobStore | undefined;
  /** Cannot diff against nothing; absent → skipped. */
  startRef: SessionStartRef | undefined;
  /** Live sandbox handle, or null when the attachment isn't `ready` — do NOT
   * force a re-provision just to capture a diff. */
  sandbox: Sandbox | null;
  /** Attachment state, used for the skip reason when `sandbox` is null. */
  attachmentState: string;
}

/** POSIX single-quote escaping for values interpolated into `sh` command
 * strings (same idiom as the api's workspace prep). */
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export async function capturePatch(ctx: PatchCaptureContext): Promise<SettlePatchRef> {
  try {
    return await capturePatchInner(ctx);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(
      `[engine] patch capture failed (session=${ctx.sessionId}, item=${ctx.queueItemId}):`,
      reason,
    );
    return { status: "failed", reason };
  }
}

async function capturePatchInner(ctx: PatchCaptureContext): Promise<SettlePatchRef> {
  const { blobs, startRef, sandbox } = ctx;
  if (!blobs) return { status: "skipped", reason: "no_blob_store" };
  if (!startRef) return { status: "skipped", reason: "no_start_ref" };
  if (!sandbox) return { status: "skipped", reason: `sandbox_${ctx.attachmentState}` };

  const exec = async (command: string) => {
    try {
      return await sandbox.exec(command, { timeout: EXEC_TIMEOUT_MS });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`sandbox_exec: ${msg}`);
    }
  };

  // Non-git workspace (tarball sandboxes): skip, never fabricate a diff.
  const probe = await exec("git rev-parse --is-inside-work-tree");
  if (probe.exitCode !== 0) return { status: "skipped", reason: "not_a_git_workspace" };

  // `add -N` records intent-to-add stubs so the diff includes new files; the
  // trailing `reset -q` restores a clean index (belt-and-braces — the stubs
  // themselves are harmless to subsequent git operations).
  const addN = await exec("git add -N .");
  if (addN.exitCode !== 0) {
    return { status: "failed", reason: `git_add_intent: ${addN.stderr.trim() || addN.stdout.trim()}` };
  }
  const diff = await exec(`git diff ${shQuote(startRef.commitSha)}`);
  await exec("git reset -q").catch(() => undefined);
  if (diff.exitCode !== 0) {
    return { status: "failed", reason: `git_diff: ${diff.stderr.trim() || diff.stdout.trim()}` };
  }
  if (diff.timedOut) return { status: "failed", reason: "sandbox_exec_timeout" };

  let patch = diff.stdout;
  const originalBytes = byteLength(patch);
  let truncated = false;
  if (originalBytes > MAX_PATCH_BYTES) {
    const marker = `\n\n[TRUNCATED: original patch was ${originalBytes} bytes; only the first 2 MiB stored]\n`;
    patch = truncateToBytes(patch, MAX_PATCH_BYTES - byteLength(marker)) + marker;
    truncated = true;
  }

  const key = patchBlobKey(ctx.sessionId, ctx.queueItemId);
  const data = new TextEncoder().encode(patch);
  try {
    await blobs.put(key, data, { contentType: "text/x-diff" });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: "failed", reason: `blob_put: ${msg}` };
  }
  return { status: "captured", blobKey: key, bytes: data.length, ...(truncated ? { truncated } : {}) };
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Truncate to at most `maxBytes` UTF-8 bytes without splitting a code point. */
function truncateToBytes(s: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(s);
  if (encoded.length <= maxBytes) return s;
  return new TextDecoder("utf-8", { fatal: false })
    .decode(encoded.subarray(0, Math.max(0, maxBytes)))
    // Strip a trailing replacement char from a split code point.
    .replace(/�$/, "");
}
