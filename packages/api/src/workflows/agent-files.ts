import { SANDBOX_READY_TIMEOUT_MS, type Sandbox, type Session } from "@valet/engine";
import { AgentInputFileError, validateRenderedAgentFiles, type RenderedAgentFile } from "@valet/workflow";
import { randomUUID } from "node:crypto";
import type { WorkflowStore } from "@valet/workflow";
import { posix } from "node:path";

/** Crash windows can miss settlement cleanup. Bound that residual retention. */
export const AGENT_INPUT_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const AGENT_INPUT_SWEEP_LIMIT = 100;
const sweepOffsets = new WeakMap<Sandbox, number>();
const INPUT_ROOT = ".valet/workflow-inputs";
const AGE_MARKER = ".created-at";

interface InputFileOptions {
  dispatchId: string;
  files?: RenderedAgentFile[];
}

function inputDirectory(workspace: string, dispatchId: string): string {
  const parts = dispatchId.split(":");
  const [kind, runId, nodeId, iteration = "0"] = parts;
  if (kind !== "workflow" || parts.length > 4 || !runId || !nodeId ||
      !/^[A-Za-z0-9_-]+$/.test(runId) || !/^[A-Za-z0-9_-]+$/.test(nodeId) ||
      !/^(0|[1-9][0-9]*)$/.test(iteration)) {
    throw new AgentInputFileError("Workflow input dispatch ID is invalid. Use workflow:{runId}:{nodeId}[:{iteration}].");
  }
  return posix.resolve(workspace, INPUT_ROOT, runId, nodeId, iteration);
}

function prepareInputs(workspace: string, opts: InputFileOptions): Array<{ path: string; bytes: Uint8Array }> {
  if (!opts.files?.length) return [];
  validateRenderedAgentFiles(opts.files);
  const root = inputDirectory(workspace, opts.dispatchId);
  return opts.files.map((file) => {
    const path = posix.resolve(root, file.path);
    if (!path.startsWith(`${root}/`)) {
      throw new AgentInputFileError(`Input file ${JSON.stringify(file.path)} escapes its directory. Use a relative path without dot segments.`);
    }
    return { path, bytes: new TextEncoder().encode(file.content) };
  });
}

function withManifest(prompt: string, inputs: Array<{ path: string; bytes: Uint8Array }>): string {
  if (!inputs.length) return prompt;
  return [prompt, "", "Workflow input files:",
    "These files hold the workflow's input data. Read the data from disk.",
    ...inputs.map((input) => `- ${input.path} (${input.bytes.byteLength} bytes)`),
  ].join("\n");
}

/** Reconstruct delivered text for retained-admission checks without writing files. */
export function agentInputPrompt(workspace: string, prompt: string, opts: InputFileOptions): string {
  return withManifest(prompt, prepareInputs(workspace, opts));
}

function hasCode(err: unknown, code: string): boolean {
  return err !== null && typeof err === "object" && "code" in err && err.code === code;
}

/** Only paths enter the rename command. Contents go through writeBinary/stdin. */
async function atomicWrite(sandbox: Sandbox, path: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await sandbox.writeBinary(temporary, bytes);
    const quote = (value: string) => `'${value.replace(/'/g, "'\"'\"'")}'`;
    const result = await sandbox.exec(`mv -f -- ${quote(temporary)} ${quote(path)}`);
    if (result.exitCode !== 0) throw new AgentInputFileError(`Could not rename workflow input: ${result.stderr}. Check sandbox permissions and retry the run.`);
  } finally {
    try { await sandbox.rm(temporary); }
    catch (err) { console.warn(`workflow input temporary cleanup failed for ${temporary}:`, err); }
  }
}

/** Readiness and unknown transport failures retain normal drive retry semantics. */
export async function writeAgentInputFiles(
  session: Session, workspace: string, prompt: string, opts: InputFileOptions, store: Pick<WorkflowStore, "getRun">,
): Promise<string> {
  const inputs = prepareInputs(workspace, opts);
  if (!inputs.length) return prompt;
  const { sandbox } = await session.attachment.ensureReady({ timeoutMs: SANDBOX_READY_TIMEOUT_MS });
  try {
    const runRoot = posix.dirname(posix.dirname(inputDirectory(workspace, opts.dispatchId)));
    await sandbox.mkdir(runRoot);
    await atomicWrite(sandbox, posix.join(runRoot, AGE_MARKER), new TextEncoder().encode(String(Date.now())));
    await sweepAgentInputFiles(sandbox, workspace, opts.dispatchId.split(":")[1], store);
    // Before admission no turn can read these files. Replace any incomplete
    // prior attempt instead of treating transport truncation as a conflict.
    for (const input of inputs) {
      await sandbox.mkdir(posix.dirname(input.path));
      await atomicWrite(sandbox, input.path, input.bytes);
    }
  } catch (err) {
    // Only deterministic filesystem failures settle the node. Provider/transport
    // errors without these codes propagate, just as ordinary admission does.
    const deterministic = ["EACCES", "EPERM", "ENOSPC", "EROFS", "ENOTDIR", "EISDIR", "ENAMETOOLONG"].some(code => hasCode(err, code)) ||
      (err instanceof Error && /Permission denied|No space left on device|Read-only file system|Not a directory|Is a directory|File name too long/.test(err.message));
    if (!deterministic) throw err;
    throw new AgentInputFileError(`Could not write workflow input files: ${err instanceof Error ? err.message : String(err)}. Check the sandbox permissions and disk space, then retry the run.`);
  }
  return withManifest(prompt, inputs);
}

/** Bounded, rotating scan. Crash leftovers are expected; failures remain visible. */
export async function sweepAgentInputFiles(sandbox: Sandbox, workspace: string, currentRun: string, store: Pick<WorkflowStore, "getRun">, now = Date.now()): Promise<void> {
  const root = posix.resolve(workspace, INPUT_ROOT);
  try {
    const names = (await sandbox.readdir(root)).filter(name => /^[A-Za-z0-9_-]+$/.test(name) && name !== currentRun).sort();
    if (!names.length) return;
    const offset = (sweepOffsets.get(sandbox) ?? 0) % names.length;
    const count = Math.min(names.length, AGENT_INPUT_SWEEP_LIMIT);
    sweepOffsets.set(sandbox, offset + count);
    for (let i = 0; i < count; i++) {
      const directory = posix.join(root, names[(offset + i) % names.length]);
      try {
        const createdAt = Number(await sandbox.readFile(posix.join(directory, AGE_MARKER)));
        if (Number.isFinite(createdAt) && createdAt > 0 && createdAt < now - AGENT_INPUT_RETENTION_MS) {
          const run = await store.getRun(names[(offset + i) % names.length]);
          if (!run || run.status === "settled") await sandbox.rm(directory, { recursive: true });
        }
      } catch (err) {
        console.warn(`workflow input sweep failed for ${directory}:`, err);
      }
    }
  } catch (err) {
    if (!hasCode(err, "ENOENT")) console.warn(`workflow input sweep failed for ${root}:`, err);
  }
}

/** Never make cleanup failure change a node or run outcome. */
export async function cleanupAgentInputFiles(session: Session, workspace: string, scope: { dispatchId: string } | { runId: string }): Promise<void> {
  try {
    const directory = "dispatchId" in scope ? inputDirectory(workspace, scope.dispatchId)
      : /^[A-Za-z0-9_-]+$/.test(scope.runId) ? posix.resolve(workspace, INPUT_ROOT, scope.runId) : undefined;
    if (!directory) throw new Error("Invalid workflow run ID for input cleanup");
    if (session.attachment.state !== "ready") return;
    const sandbox = session.attachment.current();
    if (!sandbox) return;
    await sandbox.rm(directory, { recursive: true });
  } catch (err) {
    if (!hasCode(err, "ENOENT")) console.warn(`workflow input cleanup failed for ${session.id}:`, err);
  }
}
