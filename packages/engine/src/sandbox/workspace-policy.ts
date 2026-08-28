/**
 * The checkpoint/restore policy kernel (workspace-persistence spec, Part
 * 02). Every timing decision lives in this one pure function: no I/O, no
 * clock reads — the caller injects `nowMs` and the store-lookup result, so
 * every branch of the decision table is unit-testable with fixed inputs.
 */

export type LifecycleEvent =
  | { kind: "create"; workspaceEmpty: boolean }
  | { kind: "suspend" }
  | { kind: "reap" }
  | { kind: "periodic" };

export interface PolicyConfig {
  /** Rate limit for the `periodic` and `suspend` events. */
  minCheckpointIntervalMs: number;
  checkpointOnReap: boolean;
  onRestoreFailure: "fallback" | "block";
}

export interface PolicyInput {
  event: LifecycleEvent;
  hasCommittedCheckpoint: boolean;
  lastCheckpointAtMs: number | null;
  nowMs: number;
  config: PolicyConfig;
}

export type PolicyDecision =
  | { action: "restore" }
  | { action: "checkpoint" }
  | { action: "skip"; reason: string };

/** The normative decision table (spec Part 02). Deterministic in its
 * inputs; returns exactly one row's result. */
export function decide(input: PolicyInput): PolicyDecision {
  const { event, config } = input;
  switch (event.kind) {
    case "create": {
      if (!event.workspaceEmpty) return { action: "skip", reason: "INV-1 non empty" };
      if (input.hasCommittedCheckpoint) return { action: "restore" };
      return { action: "skip", reason: "cold start from image" };
    }
    case "suspend":
      return rateLimited(input) ? { action: "skip", reason: "rate limited" } : { action: "checkpoint" };
    case "reap":
      return config.checkpointOnReap
        ? { action: "checkpoint" }
        : { action: "skip", reason: "reap checkpoint disabled" };
    case "periodic":
      return rateLimited(input) ? { action: "skip", reason: "rate limited" } : { action: "checkpoint" };
  }
}

function rateLimited(input: PolicyInput): boolean {
  if (input.lastCheckpointAtMs === null) return false;
  return input.nowMs - input.lastCheckpointAtMs < input.config.minCheckpointIntervalMs;
}
