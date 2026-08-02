/**
 * Applied-state file: diff and convergent plan runner.
 *
 * APPLIED_PATH lives in /etc/valet inside the container filesystem — NOT in
 * /workspace. This is intentional: the file must die with the pod/container
 * so the next cold boot re-evaluates the full desired spec.
 *
 * The specHash written mid-plan is the DESIRED spec's hash. It only reflects
 * "true" observed state when all planned steps have landed. Partial progress
 * is visible: the `steps` record contains only the ids that completed
 * successfully so far. Callers should treat a mismatch between the desired
 * step list and `steps` keys as evidence that the prior run was interrupted.
 */

import type { Sandbox, PrepStep, DesiredSandboxSpec } from "../types.js";

/** Absolute path of the applied-state file inside the container filesystem. */
export const APPLIED_PATH = "/etc/valet/applied.json";

/**
 * Persisted record of what the sandbox has successfully applied.
 * `steps` maps each step id to the hash that was successfully applied.
 */
export interface AppliedState {
  image: string;
  specHash: string;
  steps: Record<string, string>;
}

/**
 * Read the applied-state file from the sandbox.
 * Returns null when the file is missing or contains corrupt JSON.
 */
export async function readAppliedState(sandbox: Sandbox): Promise<AppliedState | null> {
  let raw: string;
  try {
    raw = await sandbox.readFile(APPLIED_PATH);
  } catch {
    // File missing — treat as no applied state
    return null;
  }
  try {
    return JSON.parse(raw) as AppliedState;
  } catch {
    // Corrupt JSON — treat as no applied state (spec decision 3: full re-apply)
    return null;
  }
}

/**
 * Compute the subset of desired steps that must run.
 *
 * A step must run when:
 * - applied is null (no prior state at all), OR
 * - the step id is absent from applied.steps, OR
 * - the step's hash differs from what was last applied for that id.
 *
 * The returned steps preserve the original order from `desired`.
 */
export function diffSteps(desired: PrepStep[], applied: AppliedState | null): PrepStep[] {
  if (!applied) return desired.slice();
  return desired.filter(
    (step) => applied.steps[step.id] !== step.hash,
  );
}

/**
 * Write the full applied-state file.
 * Creates /etc/valet via exec first — some providers' writeFile has no parent
 * directory creation (the virtual sandbox's writeFile does create parents, but
 * real container providers such as docker and kubernetes do not guarantee it).
 */
async function writeAppliedState(
  sandbox: Sandbox,
  state: AppliedState,
): Promise<void> {
  // mkdir -p is best-effort: real container sandboxes need it; virtual sandbox
  // writeFile creates parents automatically so this exec returning 127 is safe.
  await sandbox.exec("mkdir -p /etc/valet");
  await sandbox.writeFile(APPLIED_PATH, JSON.stringify(state));
}

/**
 * Run the convergent plan for a sandbox.
 *
 * 1. Calls diffSteps to find which steps must run.
 * 2. Runs each pending step in order.
 * 3. After EACH successful step, rewrites the full applied file with:
 *    `{ image, specHash: desired.specHash, steps: { ...prior, [step.id]: step.hash } }`.
 *    The prior step ids are merged from `applied.steps` (existing applied state)
 *    so skipped steps are not erased from the record.
 * 4. Non-critical step failure: logs one line via console.error and continues.
 * 5. Critical step failure: re-throws (caller maps to SandboxPreparationError).
 */
export async function applyPlan(
  sandbox: Sandbox,
  desired: DesiredSandboxSpec,
  image: string,
  applied: AppliedState | null,
): Promise<void> {
  const pending = diffSteps(desired.steps, applied);
  if (pending.length === 0) return;

  // Start with whatever was already successfully applied (skipped steps keep
  // their recorded hashes so we don't erase prior work from the file).
  const completedSteps: Record<string, string> = applied ? { ...applied.steps } : {};

  for (const step of pending) {
    try {
      await step.apply(sandbox);
    } catch (err) {
      if (step.critical) {
        // Critical failure: caller wraps in SandboxPreparationError
        throw err;
      }
      console.error(
        `[applied-state] non-critical step "${step.id}" failed: ${(err as Error).message}`,
      );
      // Do NOT record this step as applied; skip to the next one
      continue;
    }

    // Step succeeded — persist immediately so partial progress survives a kill
    completedSteps[step.id] = step.hash;
    await writeAppliedState(sandbox, {
      image,
      specHash: desired.specHash,
      steps: { ...completedSteps },
    });
  }
}
