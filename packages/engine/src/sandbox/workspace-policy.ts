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
  /** Rate limit for the `periodic` event only. `suspend` and `reap` are
   * durability moments (the pod — and with it the emptyDir workspace —
   * goes away) and are never rate limited. */
  minCheckpointIntervalMs: number;
  checkpointOnReap: boolean;
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
      // Suspend scales the pod to zero and destroys the emptyDir-backed
      // workspace; the suspend-time checkpoint is the only copy of writes
      // since the last commit. Rate-limiting it would silently discard up
      // to one interval of work on every hibernation.
      return { action: "checkpoint" };
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
