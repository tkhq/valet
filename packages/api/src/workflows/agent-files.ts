import { SANDBOX_READY_TIMEOUT_MS, type Sandbox, type Session } from "@valet/engine";
import { AgentInputFileError, validateRenderedAgentFiles, type RenderedAgentFile } from "@valet/workflow";
import { randomUUID } from "node:crypto";
import type { AppDb } from "../lib/drizzle.js";
import { scopedInputRunStatus, type InputSandboxScope } from "./input-scope.js";
import { recordWorkflowInputCleanupSkipped, recordWorkflowInputSweepSkipped } from "../observability/workflow-input-metrics.js";
import { posix } from "node:path";

export const SHARED_ASSISTANT_INPUT_ERROR = "Workflow input files cannot be delivered into a shared assistant sandbox. Use a session step for agent work that needs input files.";

export const UNVERIFIED_INPUT_AUDIENCE_ERROR = "Workflow input audience could not be verified. Check the actor's team membership or channel privacy, or use a session step.";

/** Crash windows can miss settlement cleanup. Bound that residual retention. */
export const AGENT_INPUT_RETENTION_MS = 7 * 24 * 60 * 60_000;
export const AGENT_INPUT_SWEEP_LIMIT = 100;
const INPUT_ROOT = ".valet/workflow-inputs";
const STAGING_ROOT = ".valet/workflow-staging";
const SWEEP_BUDGET_MS = 5_000;
const AGE_MARKER = ".created-at";

interface InputFileOptions {
  dispatchId: string;
  files?: RenderedAgentFile[];
  inputAttempt?: number;
}

function inputDirectory(workspace: string, dispatchId: string, root = INPUT_ROOT): string {
  const parts = dispatchId.split(":");
  const [kind, runId, nodeId, iteration = "0"] = parts;
  if (kind !== "workflow" || parts.length > 4 || !runId || !nodeId ||
      !/^[A-Za-z0-9_-]+$/.test(runId) || !/^[A-Za-z0-9_-]+$/.test(nodeId) ||
      !/^(0|[1-9][0-9]*)$/.test(iteration)) {
    throw new AgentInputFileError("Workflow input dispatch ID is invalid. Use workflow:{runId}:{nodeId}[:{iteration}].");
  }
  return posix.resolve(workspace, root, runId, nodeId, iteration);
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

function stagingDirectory(workspace: string, dispatchId: string): string {
  return inputDirectory(workspace, dispatchId, STAGING_ROOT);
}

/** Only reserved attempt directories qualify. User paths are never staging. */
async function cleanupStaleTemps(sandbox: Sandbox, directory: string, attempt: number): Promise<void> {
  for (const name of await sandbox.readdir(directory)) {
    const stagedAttempt = /^attempt-(0|[1-9][0-9]*)$/.exec(name)?.[1];
    if (stagedAttempt !== undefined && Number(stagedAttempt) < attempt) {
      await sandbox.rm(posix.join(directory, name), { recursive: true });
    }
  }
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\"'\"'")}'`;
}

export function logInputCleanupSkipped(sessionId: string, scope: "node" | "run", reason: string): void {
  recordWorkflowInputCleanupSkipped(scope, reason);
  console.warn("workflow input cleanup skipped", { sessionId, scope, reason });
}

/** Only paths enter the rename command. Contents go through writeBinary/stdin. */
async function atomicWrite(sandbox: Sandbox, path: string, bytes: Uint8Array, staging: string): Promise<void> {
  const temporary = posix.join(staging, `${posix.basename(path)}-${randomUUID()}`);
  try {
    await sandbox.writeBinary(temporary, bytes);
    const result = await sandbox.exec(`mv -f -- ${quote(temporary)} ${quote(path)}`);
    // Providers reject dead-container/socket failures. Timeouts and signal
    // interruption can instead resolve as results (including k8s abort 124).
    // Docker providers throw client transport/setup failures. A resolved 126
    // is a real command execution failure, not a transport signal.
    if (result.timedOut || (result.exitCode === 124 || result.exitCode === 125) || result.exitCode >= 128 || result.exitCode < 0) {
      throw new Error(`Workflow input rename did not complete (exit ${result.exitCode}${result.timedOut ? ", timed out" : ", interrupted"}). Retry the run.`);
    }
    if (result.exitCode !== 0) throw new AgentInputFileError(`Could not rename workflow input (exit ${result.exitCode}): ${result.stderr.trim() || "command failed without stderr"}. Check sandbox permissions and retry the run.`);
  } finally {
    try { await sandbox.rm(temporary); }
    catch (err) { console.warn(`workflow input temporary cleanup failed for ${temporary}:`, err); }
  }
}

/** Readiness and unknown transport failures retain normal drive retry semantics. */
export async function writeAgentInputFiles(
  session: Session, workspace: string, prompt: string, opts: InputFileOptions, db: AppDb,
): Promise<string> {
  const inputs = prepareInputs(workspace, opts);
  if (!inputs.length) return prompt;
  const attempt = opts.inputAttempt ?? 0;
  if (!Number.isSafeInteger(attempt) || attempt < 0) throw new AgentInputFileError("Workflow input attempt is invalid. Use the current run attempt.");
  const { sandbox } = await session.attachment.ensureReady({ timeoutMs: SANDBOX_READY_TIMEOUT_MS });
  try {
    const runRoot = posix.dirname(posix.dirname(inputDirectory(workspace, opts.dispatchId)));
    await sandbox.mkdir(runRoot);
    const stagingRoot = stagingDirectory(workspace, opts.dispatchId);
    await sandbox.mkdir(stagingRoot);
    await cleanupStaleTemps(sandbox, stagingRoot, attempt);
    const staging = posix.join(stagingRoot, `attempt-${attempt}`);
    await sandbox.mkdir(staging);
    await atomicWrite(sandbox, posix.join(runRoot, AGE_MARKER), new TextEncoder().encode(String(Date.now())), staging);
    const data = await session.toData();
    await sweepAgentInputFiles(sandbox, workspace, opts.dispatchId.split(":")[1], db,
      { orgId: data.orgId, ownerType: data.owner.type, ownerId: data.owner.id });
    // Before admission no turn can read these files. Replace any incomplete
    // prior attempt instead of treating transport truncation as a conflict.
    for (const input of inputs) {
      await sandbox.mkdir(posix.dirname(input.path));
      await atomicWrite(sandbox, input.path, input.bytes, staging);
    }
  } catch (err) {
    // Only deterministic filesystem failures settle the node. Provider/transport
    // errors without these codes propagate, just as ordinary admission does.
    const deterministic = ["EACCES", "EPERM", "ENOSPC", "EROFS", "ENOTDIR", "EISDIR", "ERR_FS_EISDIR", "ENAMETOOLONG"].some(code => hasCode(err, code)) ||
      (err instanceof Error && /Permission denied|No space left on device|Read-only file system|Not a directory|Is a directory|File name too long/.test(err.message));
    if (!deterministic) throw err;
    throw new AgentInputFileError(`Could not write workflow input files: ${err instanceof Error ? err.message : String(err)}. Check the sandbox permissions and disk space, then retry the run.`);
  }
  return withManifest(prompt, inputs);
}

/** Bounded scan with a stateless random start. Crash leftovers are expected; failures remain visible. */
export async function sweepAgentInputFiles(sandbox: Sandbox, workspace: string, currentRun: string, db: AppDb, scope: InputSandboxScope, now = Date.now(), random = Math.random): Promise<void> {
  const root = posix.resolve(workspace, INPUT_ROOT);
  try {
    const deadline = Date.now() + SWEEP_BUDGET_MS;
    const listing = await sandbox.exec(`ls -1A ${quote(root)}`, { timeout: 1_000, maxOutputBytes: 64 * 1024 });
    if (listing.exitCode !== 0 || listing.timedOut || listing.truncated) {
      recordWorkflowInputSweepSkipped("listing");
      throw new Error("Workflow input sweep listing failed or exceeded its limit");
    }
    const names = listing.stdout.split("\n").filter(name => /^[A-Za-z0-9_-]+$/.test(name) && name !== currentRun).sort();
    if (!names.length) return;
    const offset = Math.floor(random() * names.length);
    const count = Math.min(names.length, AGENT_INPUT_SWEEP_LIMIT);
    for (let i = 0; i < count; i++) {
      if (Date.now() >= deadline) {
        recordWorkflowInputSweepSkipped("budget");
        console.warn("workflow input sweep stopped at its time budget");
        break;
      }
      const directory = posix.join(root, names[(offset + i) % names.length]);
      try {
        // Never buffer sandbox-controlled marker contents in the API.
        const marker = await sandbox.exec(`head -c 32 -- ${quote(posix.join(directory, AGE_MARKER))}`,
          { timeout: Math.min(1_000, Math.max(1, deadline - Date.now())), maxOutputBytes: 32 });
        if (marker.exitCode !== 0 || marker.timedOut || marker.truncated || !/^[0-9]{1,16}$/.test(marker.stdout)) {
          recordWorkflowInputSweepSkipped("marker");
          throw new Error("Workflow input age marker is unreadable or invalid");
        }
        const createdAt = Number(marker.stdout);
        if (Number.isFinite(createdAt) && createdAt > 0 && createdAt < now - AGENT_INPUT_RETENTION_MS) {
          const status = await scopedInputRunStatus(db, scope, names[(offset + i) % names.length]);
          if (!status || status === "settled") {
            if (Date.now() >= deadline) {
              recordWorkflowInputSweepSkipped("budget");
              console.warn("workflow input sweep stopped before removal at its time budget");
              break;
            }
            const staging = posix.resolve(workspace, STAGING_ROOT, names[(offset + i) % names.length]);
            // Keep the marker until all contents and staging are removed, so
            // an interrupted cleanup remains eligible on the next sweep.
            const command = `find ${quote(directory)} -mindepth 1 -maxdepth 1 ! -name '${AGE_MARKER}' -exec rm -rf -- {} +` +
              ` && rm -rf -- ${quote(staging)} && rm -f -- ${quote(posix.join(directory, AGE_MARKER))} && rmdir -- ${quote(directory)}`;
            const removed = await sandbox.exec(command, { timeout: 1_000, maxOutputBytes: 1024 });
            if (removed.timedOut || removed.exitCode !== 0) {
              recordWorkflowInputSweepSkipped("removal");
              throw new Error(`Workflow input sweep removal failed (exit ${removed.exitCode}${removed.timedOut ? ", timed out" : ""})`);
            }
          }
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
    const sandbox = session.attachment.current();
    if (!sandbox) {
      logInputCleanupSkipped(session.id, "dispatchId" in scope ? "node" : "run", "unattached");
      return;
    }
    const staging = "dispatchId" in scope ? stagingDirectory(workspace, scope.dispatchId)
      : posix.resolve(workspace, STAGING_ROOT, scope.runId);
    for (const root of [directory, staging]) {
      try { await sandbox.rm(root, { recursive: true }); }
      catch (err) { if (!hasCode(err, "ENOENT")) throw err; }
    }
  } catch (err) {
    if (!hasCode(err, "ENOENT")) console.warn(`workflow input cleanup failed for ${session.id}:`, err);
  }
}
