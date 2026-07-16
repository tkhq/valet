/**
 * File ops over `pods/exec` (decision 5) — there is no host mount to read
 * from directly (unlike sandbox-docker's bind-mounted workspace), so every
 * operation here rides `execInPod`.
 *
 * Byte fidelity via base64, streamed over stdin instead of embedded in the
 * command string: writeBinary/writeFile both base64-encode locally and hand
 * the payload to `execInPod` as `opts.stdin`, decoded pod-side with
 * `base64 -d`. This was a deliberate choice over the brief's "chunk long
 * payloads to stay under ARG_MAX" fallback — the k8s exec API's stdin
 * channel is a real stream (frames multiplexed over the same WebSocket,
 * see exec.ts), so there's no OS `ARG_MAX` (~2MB on Linux, and Kubernetes
 * itself additionally caps exec *command strings*, not stdin) to chunk
 * around in the first place. One `base64 -d > file` exec call handles any
 * payload size.
 *
 * Reads use `base64 -w0`, not the brief's `base64 | tr -d '\n'` fallback.
 * `-w0` (disable line-wrapping) is supported by both GNU coreutils' `base64`
 * (Debian sandbox images) and BusyBox's `base64` applet (the `busybox:stable`
 * image the cluster test suite runs against) — verified against BusyBox's
 * own `base64 --help` (`-w N  Wrap output at N columns (default 76, 0
 * disables)`). Piping through `tr` would also make the read command's exit
 * status reflect `tr` instead of `base64` (POSIX `sh` has no `pipefail`),
 * which matters here: a non-zero exit from the read command is exactly how
 * `readFile`/`readBinary`/`stat`/`readdir` detect a missing path.
 */
import type { ExecOpts } from "@valet/engine";
import { EXEC_DEFAULT_TIMEOUT_MS, execInPod, shQuote, type ExecDeps } from "./exec.js";

/** Directory listing errors (`ls`/`test` non-zero), stat probe failures,
 * and any other non-zero exec result from a file op surface as this —
 * consistent with the docker provider surfacing node:fs's own rejections
 * unchanged (no bespoke error type there either).
 *
 * `exitCode` is exposed publicly (not just embedded in the message text) so
 * `provider.ts`'s death-detection can distinguish a genuine application-level
 * failure (e.g. exit 2, "no such file") from a signal-shaped exit (137, a
 * `SIGKILL`) worth confirming against pod liveness before deciding whether
 * to translate this into a transport-failure the attachment layer degrades
 * on — mirrors sandbox-docker's `looksSignalKilled` heuristic (see
 * ./provider.ts), just triggered off this error's exit code instead of a
 * raw `ExecResult`.
 */
export class PodFileOpError extends Error {
  readonly exitCode: number;

  constructor(op: string, path: string, exitCode: number, stderr: string) {
    super(`${op} ${path} failed (exit ${exitCode}): ${stderr.trim() || "<no stderr>"}`);
    this.name = "PodFileOpError";
    this.exitCode = exitCode;
  }
}

async function runOrThrow(
  deps: ExecDeps,
  podName: string,
  op: string,
  path: string,
  command: string,
  opts?: ExecOpts,
) {
  const result = await execInPod(deps, podName, command, opts);
  if (result.timedOut) {
    // Distinct message from the generic exit-code case below: an ordinary
    // command failure has real stderr, but a timeout means the pod never
    // answered at all — "<no stderr>" would be misleading here.
    const deadlineMs = opts?.timeout ?? EXEC_DEFAULT_TIMEOUT_MS;
    throw new PodFileOpError(op, path, result.exitCode, `pod was not execable within ${deadlineMs}ms`);
  }
  if (result.exitCode !== 0) {
    throw new PodFileOpError(op, path, result.exitCode, result.stderr);
  }
  return result;
}

// ── Pure command builders (unit-tested without a cluster) ──────────────

export function readBinaryCommand(path: string): string {
  return `base64 -w0 ${shQuote(path)}`;
}

export function writeBinaryCommand(path: string): string {
  // No pre-write mkdir — same rationale as sandbox-docker's writeFile
  // comment: the PolicySandbox wrapper owns write-with-parent-creation
  // (attempt write, mkdir parent + retry once on rejection). A write
  // against a missing parent directory fails here exactly like
  // node:fs.writeFile does against a missing parent.
  return `base64 -d > ${shQuote(path)}`;
}

export function readdirCommand(path: string): string {
  // -1 (one entry per line) -A (all entries except "." and "..") — matches
  // node:fs.readdir's contract (dotfiles included, "."/".." excluded).
  return `ls -1A ${shQuote(path)}`;
}

export function statCommand(path: string): string {
  const q = shQuote(path);
  // wc -c < file (input via redirect, not `wc -c file`) omits the filename
  // node normally appends to `wc`'s output — keeps the probe's stdout a
  // single bare integer.
  return `if [ -d ${q} ]; then echo "d 0"; elif [ -f ${q} ]; then printf 'f %s\\n' "$(wc -c < ${q})"; else exit 2; fi`;
}

export function mkdirCommand(path: string): string {
  return `mkdir -p ${shQuote(path)}`;
}

export function rmCommand(path: string, recursive: boolean): string {
  return recursive ? `rm -rf ${shQuote(path)}` : `rm -f ${shQuote(path)}`;
}

/**
 * Parses `statCommand`'s single-line probe output (`"d 0"` / `"f <size>"`)
 * into the engine's `stat()` shape. Pure and exported for unit testing.
 */
export function parseStatOutput(stdout: string): { isFile: boolean; isDirectory: boolean; size: number } {
  const trimmed = stdout.trim();
  const match = /^([df]) (\d+)$/.exec(trimmed);
  if (!match) {
    throw new Error(`statCommand: unexpected probe output ${JSON.stringify(stdout)}`);
  }
  const [, kind, sizeText] = match;
  return { isFile: kind === "f", isDirectory: kind === "d", size: Number(sizeText) };
}

/** Splits `ls -1A`'s output into individual names, dropping the trailing
 * blank line a POSIX-terminated command output always has. Empty
 * directories produce empty stdout → `[]`, not `[""]`. */
export function parseReaddirOutput(stdout: string): string[] {
  if (stdout.length === 0) return [];
  return stdout.split("\n").filter((line) => line.length > 0);
}

// ── Sandbox-facing operations ───────────────────────────────────────────

export async function readFileInPod(deps: ExecDeps, podName: string, path: string): Promise<string> {
  const bytes = await readBinaryInPod(deps, podName, path);
  return Buffer.from(bytes).toString("utf8");
}

export async function readBinaryInPod(deps: ExecDeps, podName: string, path: string): Promise<Uint8Array> {
  const result = await runOrThrow(deps, podName, "readBinary", path, readBinaryCommand(path));
  const buf = Buffer.from(result.stdout.trim(), "base64");
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

export async function writeFileInPod(deps: ExecDeps, podName: string, path: string, content: string): Promise<void> {
  await writeBinaryInPod(deps, podName, path, new Uint8Array(Buffer.from(content, "utf8")));
}

export async function writeBinaryInPod(
  deps: ExecDeps,
  podName: string,
  path: string,
  data: Uint8Array,
): Promise<void> {
  const stdin = Buffer.from(data).toString("base64");
  await runOrThrow(deps, podName, "writeBinary", path, writeBinaryCommand(path), { stdin });
}

export async function readdirInPod(deps: ExecDeps, podName: string, path: string): Promise<string[]> {
  const result = await runOrThrow(deps, podName, "readdir", path, readdirCommand(path));
  return parseReaddirOutput(result.stdout);
}

export async function statInPod(
  deps: ExecDeps,
  podName: string,
  path: string,
): Promise<{ isFile: boolean; isDirectory: boolean; size: number }> {
  const result = await runOrThrow(deps, podName, "stat", path, statCommand(path));
  return parseStatOutput(result.stdout);
}

export async function mkdirInPod(deps: ExecDeps, podName: string, path: string): Promise<void> {
  await runOrThrow(deps, podName, "mkdir", path, mkdirCommand(path));
}

export async function rmInPod(
  deps: ExecDeps,
  podName: string,
  path: string,
  opts?: { recursive?: boolean },
): Promise<void> {
  await runOrThrow(deps, podName, "rm", path, rmCommand(path, opts?.recursive ?? false));
}
