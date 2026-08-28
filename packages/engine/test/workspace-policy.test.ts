import { describe, expect, it } from "vitest";
import { decide, type PolicyConfig, type PolicyInput } from "../src/sandbox/workspace-policy.js";

const config: PolicyConfig = {
  minCheckpointIntervalMs: 5 * 60_000,
  checkpointOnReap: true,
};

function input(overrides: Partial<PolicyInput>): PolicyInput {
  return {
    event: { kind: "periodic" },
    hasCommittedCheckpoint: false,
    lastCheckpointAtMs: null,
    nowMs: 1_000_000,
    config,
    ...overrides,
  };
}

// One test per decision-table row (spec Part 02) — fixed inputs, no clock.
describe("workspace policy kernel decision table", () => {
  it("create + empty + committed checkpoint → restore", () => {
    expect(
      decide(input({ event: { kind: "create", workspaceEmpty: true }, hasCommittedCheckpoint: true })),
    ).toEqual({ action: "restore" });
  });

  it("create + empty + no checkpoint → skip (cold start from image)", () => {
    expect(
      decide(input({ event: { kind: "create", workspaceEmpty: true }, hasCommittedCheckpoint: false })),
    ).toEqual({ action: "skip", reason: "cold start from image" });
  });

  it("create + non-empty → skip (INV-1), even when a checkpoint exists", () => {
    expect(
      decide(input({ event: { kind: "create", workspaceEmpty: false }, hasCommittedCheckpoint: true })),
    ).toEqual({ action: "skip", reason: "INV-1 non empty" });
  });

  it("suspend + interval elapsed → checkpoint", () => {
    expect(
      decide(
        input({
          event: { kind: "suspend" },
          lastCheckpointAtMs: 1_000_000 - config.minCheckpointIntervalMs,
        }),
      ),
    ).toEqual({ action: "checkpoint" });
  });

  it("suspend + no prior checkpoint → checkpoint", () => {
    expect(decide(input({ event: { kind: "suspend" }, lastCheckpointAtMs: null }))).toEqual({
      action: "checkpoint",
    });
  });

  it("suspend + inside interval → checkpoint (suspend is never rate limited)", () => {
    // The pod and its emptyDir workspace go away at suspend; skipping this
    // checkpoint would permanently lose the writes since the last commit.
    expect(
      decide(
        input({
          event: { kind: "suspend" },
          lastCheckpointAtMs: 1_000_000 - config.minCheckpointIntervalMs + 1,
        }),
      ),
    ).toEqual({ action: "checkpoint" });
  });

  it("reap + checkpointOnReap → checkpoint", () => {
    expect(decide(input({ event: { kind: "reap" } }))).toEqual({ action: "checkpoint" });
  });

  it("reap + checkpointOnReap disabled → skip", () => {
    expect(
      decide(input({ event: { kind: "reap" }, config: { ...config, checkpointOnReap: false } })),
    ).toEqual({ action: "skip", reason: "reap checkpoint disabled" });
  });

  it("periodic + interval elapsed → checkpoint", () => {
    expect(
      decide(
        input({
          event: { kind: "periodic" },
          lastCheckpointAtMs: 1_000_000 - config.minCheckpointIntervalMs,
        }),
      ),
    ).toEqual({ action: "checkpoint" });
  });

  it("periodic + no prior checkpoint → checkpoint", () => {
    expect(decide(input({ event: { kind: "periodic" }, lastCheckpointAtMs: null }))).toEqual({
      action: "checkpoint",
    });
  });

  it("periodic + inside interval → skip (rate limited)", () => {
    expect(
      decide(
        input({
          event: { kind: "periodic" },
          lastCheckpointAtMs: 1_000_000 - config.minCheckpointIntervalMs + 1,
        }),
      ),
    ).toEqual({ action: "skip", reason: "rate limited" });
  });

  it("is deterministic: identical inputs produce identical decisions", () => {
    const fixed = input({ event: { kind: "suspend" }, lastCheckpointAtMs: 700_000 });
    expect(decide(fixed)).toEqual(decide(fixed));
  });
});
