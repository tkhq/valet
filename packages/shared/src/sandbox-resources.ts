import { parseResourceQuantity } from "./resource-quantity.js";

/**
 * Platform CPU ceiling for one sandbox.
 *
 * Kubernetes has no portable CPU maximum. Valet uses 64 cores because it fits
 * on common high-core nodes while rejecting values that cannot be scheduled by
 * ordinary clusters. Keep fractional CPU support: the valid range is (0, 64].
 */
export const MAX_SANDBOX_CPU = 64;

/** True when a CPU value is finite and inside Valet's sandbox CPU range. */
export function isValidSandboxCpu(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= MAX_SANDBOX_CPU;
}

/** Human-readable range generated from the shared ceiling. */
export function sandboxCpuRange(): string {
  return `greater than 0 and at most ${MAX_SANDBOX_CPU}`;
}

/** Scratch caps a deployment sets. `max` undefined means scratch is disabled. */
export interface ScratchCaps {
  max?: string;
  agentMax?: string;
}

export type ScratchSource = "task" | "prebuild" | "saved" | "create";
export type ScratchRefusalReason = "invalid" | "disabled" | "deploy_cap" | "agent_cap";

export const MIN_SCRATCH_BYTES = 2 ** 30;

/** Whole bytes, or a whole number with a binary suffix. */
const SCRATCH_FORM = /^\d+(?:Ki|Mi|Gi|Ti)?$/;

export class ScratchRequestError extends Error {
  readonly code = "scratch_refused";
  constructor(readonly reason: ScratchRefusalReason, message: string) {
    super(message);
    this.name = "ScratchRequestError";
  }
}

export function isScratchRequestError(err: unknown): err is ScratchRequestError {
  return err instanceof ScratchRequestError;
}

/**
 * One validation for every scratch source (spec INV-4). Refuses, never
 * clamps. The refusal text names the knob and the corrective action. The
 * deploy cap is a chart value an admin sets; the agent cap text points a
 * `task` caller at the repository file, which may request more.
 */
export function validateScratchRequest(value: unknown, source: ScratchSource, caps: ScratchCaps): string {
  const text = typeof value === "string" ? value.trim() : "";
  const bytes = text ? parseResourceQuantity(text) : null;
  if (bytes === null || bytes < MIN_SCRATCH_BYTES) {
    throw new ScratchRequestError(
      "invalid",
      `scratch "${String(value)}" is not a Kubernetes quantity of at least 1Gi. Use a form like "200Gi".`,
    );
  }
  // The value reaches the emptyDir sizeLimit verbatim. The CRD rejects some
  // forms the parser accepts (an uppercase "K"), so only the plain forms pass.
  if (!SCRATCH_FORM.test(text)) {
    throw new ScratchRequestError(
      "invalid",
      `scratch "${text}" uses an unsupported form. Use whole bytes or a Ki, Mi, Gi, or Ti suffix, like "200Gi".`,
    );
  }
  const maxBytes = caps.max ? parseResourceQuantity(caps.max) : null;
  if (maxBytes === null || maxBytes <= 0) {
    // The agent can act on a task refusal at once; the admin steps are for a person.
    const retry = source === "task" ? " Retry without resources.scratch." : "";
    throw new ScratchRequestError(
      "disabled",
      "scratch is not enabled on this deployment. Set sandbox.scratchMax in the Valet chart (an admin task), " +
        `or VALET_SANDBOX_SCRATCH_MAX in a dev stack.${retry}`,
    );
  }
  if (bytes > maxBytes) {
    throw new ScratchRequestError(
      "deploy_cap",
      `scratch ${text} exceeds the ${caps.max} deploy cap (sandbox.scratchMax). Request at most ${caps.max}, ` +
        "or set a higher sandbox.scratchMax in the Valet chart (an admin task).",
    );
  }
  if (source === "task") {
    const agentBytes = caps.agentMax ? parseResourceQuantity(caps.agentMax) : null;
    if (agentBytes !== null && bytes > agentBytes) {
      throw new ScratchRequestError(
        "agent_cap",
        `scratch ${text} exceeds the ${caps.agentMax} agent cap (sandbox.scratchAgentMax). Retry without resources.scratch, declare it in .valet/prebuild.yaml, or ask an admin to raise the cap.`,
      );
    }
  }
  return text;
}
