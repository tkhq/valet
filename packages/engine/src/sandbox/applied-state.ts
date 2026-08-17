/**
 * Applied-state file: diff and convergent plan runner.
 *
 * APPLIED_PATH lives in /etc/valet inside the container filesystem — NOT in
 * /workspace. This is intentional: the file must die with the pod/container
 * so the next cold boot re-evaluates the full desired spec.
 *
 * All applied-file I/O is exec-based. Provider readFile/writeFile semantics
 * differ for container-fs paths outside /workspace: docker resolves them on
 * the HOST filesystem, and kubernetes writeFileInPod throws when the parent
 * directory is absent. Only VirtualSandbox's file methods work reliably at
 * arbitrary paths — exec is the common denominator across all providers.
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
 * Read the applied-state file from the sandbox via exec.
 * Returns null when the file is missing, unreadable, or contains invalid JSON.
 *
 * Uses exec("cat ...") rather than sandbox.readFile so the path resolves
 * inside the container filesystem on all provider implementations.
 */
export async function readAppliedState(sandbox: Sandbox): Promise<AppliedState | null> {
  // /etc is a system path — must run as root, not as the docker workload user.
  const result = await sandbox.exec(`cat ${APPLIED_PATH}`, { privileged: true });
  if (result.exitCode !== 0) {
    // File missing or unreadable — treat as no applied state
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    // Corrupt JSON — treat as no applied state (spec decision 3: full re-apply)
    return null;
  }
  // Shape validation: guard against partial writes or schema drift
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).image !== "string" ||
    typeof (parsed as Record<string, unknown>).specHash !== "string" ||
    typeof (parsed as Record<string, unknown>).steps !== "object" ||
    (parsed as Record<string, unknown>).steps === null ||
    !Object.values((parsed as { steps: Record<string, unknown> }).steps).every(
      (v) => typeof v === "string",
    )
  ) {
    return null;
  }
  return parsed as AppliedState;
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
 * Escape a string for use inside POSIX single quotes: replace each ' with '\''.
 */
function posixSingleQuoteEscape(s: string): string {
  return s.replace(/'/g, "'\\''");
}

/**
 * Write the full applied-state file via a single exec.
 *
 * The command does `mkdir -p /etc/valet` and writes the JSON in one shot
 * using printf. Non-zero exit is treated as a real error and re-thrown.
 *
 * Uses exec exclusively (not sandbox.writeFile) so the write lands inside the
 * container filesystem on docker and kubernetes providers.
 */
async function writeAppliedState(
  sandbox: Sandbox,
  state: AppliedState,
): Promise<void> {
  const json = posixSingleQuoteEscape(JSON.stringify(state));
  // /etc is a system path — must run as root, not as the docker workload user.
  const result = await sandbox.exec(
    `mkdir -p /etc/valet && printf '%s' '${json}' > ${APPLIED_PATH}`,
    { privileged: true },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `[applied-state] failed to write applied state (exit ${result.exitCode}): ${result.stderr}`,
    );
  }
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
 *
 * Returns the ACTUAL applied state — the last state written to the file, which
 * includes prior applied steps merged with the steps this call landed. A step
 * that failed non-critically is NOT in the returned `steps`, so the caller's
 * observation cache reflects the true on-disk state and re-runs that step on
 * the next reconcile within the TTL (spec decision 10). When no step ran, the
 * return echoes the prior applied state (or an empty state) unchanged.
 */
export async function applyPlan(
  sandbox: Sandbox,
  desired: DesiredSandboxSpec,
  image: string,
  applied: AppliedState | null,
): Promise<AppliedState> {
  // Start with whatever was already successfully applied (skipped steps keep
  // their recorded hashes so we don't erase prior work from the file).
  const completedSteps: Record<string, string> = applied ? { ...applied.steps } : {};
  const pending = diffSteps(desired.steps, applied);
  if (pending.length === 0) {
    // No step ran — echo the prior applied state (or an empty state) so the
    // caller always builds its cache from the real on-disk truth.
    return { image, specHash: applied?.specHash ?? desired.specHash, steps: completedSteps };
  }

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

  // The last state written to the file. `specHash` is the desired hash whenever
  // any step landed; when every pending step failed non-critically nothing was
  // written, so fall back to the prior applied hash (state on disk unchanged).
  const anyLanded = Object.keys(completedSteps).length > (applied ? Object.keys(applied.steps).length : 0);
  return {
    image,
    specHash: anyLanded ? desired.specHash : (applied?.specHash ?? desired.specHash),
    steps: completedSteps,
  };
}
