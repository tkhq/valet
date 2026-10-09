import { SANDBOX_READY_TIMEOUT_MS, type Session } from "@valet/engine";
import { AgentInputFileError, validateRenderedAgentFiles, type RenderedAgentFile } from "@valet/workflow";
import { posix } from "node:path";

interface InputFileOptions {
  dispatchId: string;
  files?: RenderedAgentFile[];
}

function prepareInputs(workspace: string, opts: InputFileOptions): Array<{ path: string; bytes: Uint8Array }> {
  const files = opts.files;
  if (!files?.length) return [];
  validateRenderedAgentFiles(files);
  const parts = opts.dispatchId.split(":");
  const [kind, runId, nodeId, iteration = "0"] = parts;
  if (kind !== "workflow" || parts.length > 4 || !runId || !nodeId ||
      !/^[A-Za-z0-9_-]+$/.test(runId) || !/^[A-Za-z0-9_-]+$/.test(nodeId) ||
      !/^(0|[1-9][0-9]*)$/.test(iteration)) {
    throw new AgentInputFileError("Workflow input dispatch ID is invalid. Use workflow:{runId}:{nodeId}[:{iteration}].");
  }
  // Explicit iteration 0 keeps it separate from every foreach iteration.
  const root = posix.resolve(workspace, ".valet/workflow-inputs", runId, nodeId, iteration);
  return files.map((file) => {
    const path = posix.resolve(root, file.path);
    if (!path.startsWith(`${root}/`)) {
      throw new AgentInputFileError(`Input file ${JSON.stringify(file.path)} escapes its directory. Use a relative path without dot segments.`);
    }
    return { path, bytes: new TextEncoder().encode(file.content) };
  });
}

function withManifest(prompt: string, inputs: Array<{ path: string; bytes: Uint8Array }>): string {
  if (!inputs.length) return prompt;
  return [
    prompt,
    "",
    "Workflow input files:",
    "These files hold the workflow's input data. Read the data from disk.",
    ...inputs.map((input) => `- ${input.path} (${input.bytes.byteLength} bytes)`),
  ].join("\n");
}

/** Reconstruct delivered text for retained-admission content checks without writing files. */
export function agentInputPrompt(workspace: string, prompt: string, opts: InputFileOptions): string {
  return withManifest(prompt, prepareInputs(workspace, opts));
}

/** Input writes precede durable admission. Re-dispatch rewrites the same bytes. */
export async function writeAgentInputFiles(
  session: Session,
  workspace: string,
  prompt: string,
  opts: InputFileOptions,
): Promise<string> {
  const inputs = prepareInputs(workspace, opts);
  if (!inputs.length) return prompt;
  try {
    const { sandbox } = await session.attachment.ensureReady({ timeoutMs: SANDBOX_READY_TIMEOUT_MS });
    for (const input of inputs) {
      await sandbox.mkdir(posix.dirname(input.path));
      await sandbox.writeBinary(input.path, input.bytes);
    }
  } catch (err) {
    throw new AgentInputFileError(`Could not write workflow input files: ${err instanceof Error ? err.message : String(err)}. Retry the run after checking the sandbox configuration.`);
  }
  return withManifest(prompt, inputs);
}
