/**
 * Presence derivation for a workflow run (`run-presence.ts`).
 *
 * The product rule under test: a machine-started run must not be read as
 * attended, because an attended reading is what puts a team's automation on
 * one person's personal GitHub token. The two link hops (sub-workflow child,
 * retry) exist because those two start paths stamp a trigger type that
 * describes the START MECHANISM rather than the WORK.
 *
 * `InMemoryWorkflowStore` is the real store contract, not a hand-rolled
 * stub, so the `getRun` hop is exercised the way production exercises it.
 */
import { describe, expect, it } from "vitest";
import { InMemoryWorkflowStore, type RunParams, type WorkflowRun } from "@valet/workflow";
import { presenceForTriggerType, resolveRunPresence, triggerTypeOf } from "./run-presence.js";

const DEFINITION = { version: "dag/v1", nodes: [], edges: [] };

/** Creates a run through the real store, so `resolveRunPresence` reads back
 * exactly what a persisted run looks like. */
async function seedRun(store: InMemoryWorkflowStore, runId: string, params: Partial<RunParams> & { input?: unknown }): Promise<WorkflowRun> {
  return store.createRun(
    runId,
    { workflowId: "wf1", definitionVersionId: "v1", ...params },
    DEFINITION,
    "v1",
    { ownerType: "user", ownerId: "user1" },
  );
}

function trigger(type: string): Record<string, unknown> {
  return { type, timestamp: "2026-08-17T00:00:00.000Z", data: {}, metadata: {} };
}

describe("triggerTypeOf", () => {
  it("reads every discriminant a start path can write", () => {
    expect(triggerTypeOf(trigger("manual"))).toBe("manual");
    expect(triggerTypeOf(trigger("schedule"))).toBe("schedule");
    expect(triggerTypeOf(trigger("webhook"))).toBe("webhook");
    expect(triggerTypeOf(trigger("event"))).toBe("event");
    expect(triggerTypeOf(trigger("workflow"))).toBe("workflow");
  });

  it("returns undefined for a payload with no usable discriminant", () => {
    expect(triggerTypeOf(undefined)).toBeUndefined();
    expect(triggerTypeOf(null)).toBeUndefined();
    expect(triggerTypeOf("schedule")).toBeUndefined();
    expect(triggerTypeOf(42)).toBeUndefined();
    expect(triggerTypeOf([])).toBeUndefined();
    expect(triggerTypeOf({})).toBeUndefined();
    expect(triggerTypeOf({ type: "cron" })).toBeUndefined();
    expect(triggerTypeOf({ type: 7 })).toBeUndefined();
    // A nested `type` must not be mistaken for the discriminant.
    expect(triggerTypeOf({ data: { type: "manual" } })).toBeUndefined();
  });
});

describe("presenceForTriggerType", () => {
  it("reads only `manual` as attended", () => {
    expect(presenceForTriggerType("manual")).toBe("attended");
  });

  it("reads every machine-started trigger as unattended", () => {
    expect(presenceForTriggerType("schedule")).toBe("unattended");
    expect(presenceForTriggerType("webhook")).toBe("unattended");
    expect(presenceForTriggerType("event")).toBe("unattended");
  });

  // Being wrong toward "unattended" only prefers the App, which still falls
  // back to the user credential. Being wrong toward "attended" would keep a
  // machine-started run on a personal token.
  it("reads an unknown trigger type as unattended, the safe direction", () => {
    expect(presenceForTriggerType(undefined)).toBe("unattended");
  });
});

describe("resolveRunPresence", () => {
  it("reads a scheduled run as unattended", async () => {
    const store = new InMemoryWorkflowStore();
    const run = await seedRun(store, "r1", { input: trigger("schedule") });
    expect(await resolveRunPresence(store, run)).toBe("unattended");
  });

  it("reads an event delivery as unattended", async () => {
    const store = new InMemoryWorkflowStore();
    const run = await seedRun(store, "r1", { input: trigger("event") });
    expect(await resolveRunPresence(store, run)).toBe("unattended");
  });

  it("reads a webhook delivery as unattended", async () => {
    const store = new InMemoryWorkflowStore();
    const run = await seedRun(store, "r1", { input: trigger("webhook") });
    expect(await resolveRunPresence(store, run)).toBe("unattended");
  });

  it("reads a manual start as attended", async () => {
    const store = new InMemoryWorkflowStore();
    const run = await seedRun(store, "r1", { input: trigger("manual") });
    expect(await resolveRunPresence(store, run)).toBe("attended");
  });

  it("reads a run with no trigger payload as unattended", async () => {
    const store = new InMemoryWorkflowStore();
    const run = await seedRun(store, "r1", {});
    expect(await resolveRunPresence(store, run)).toBe("unattended");
  });

  // ── the sub-workflow hop ──────────────────────────────────────────────
  // A child is always stamped `workflow`. Reading that as attended would
  // re-open the hole for every fan-out under a scheduled parent.
  describe("sub-workflow child", () => {
    it("inherits unattended from a SCHEDULED parent", async () => {
      const store = new InMemoryWorkflowStore();
      await seedRun(store, "parent", { input: trigger("schedule") });
      const child = await seedRun(store, "child", { input: trigger("workflow"), parentRunId: "parent" });
      expect(await resolveRunPresence(store, child)).toBe("unattended");
    });

    it("inherits attended from a MANUAL parent", async () => {
      const store = new InMemoryWorkflowStore();
      await seedRun(store, "parent", { input: trigger("manual") });
      const child = await seedRun(store, "child", { input: trigger("workflow"), parentRunId: "parent" });
      expect(await resolveRunPresence(store, child)).toBe("attended");
    });

    it("is unattended when the parent run is gone", async () => {
      const store = new InMemoryWorkflowStore();
      const child = await seedRun(store, "child", { input: trigger("workflow"), parentRunId: "missing" });
      expect(await resolveRunPresence(store, child)).toBe("unattended");
    });

    it("is unattended when a `workflow` run records no parent at all", async () => {
      const store = new InMemoryWorkflowStore();
      const child = await seedRun(store, "child", { input: trigger("workflow") });
      expect(await resolveRunPresence(store, child)).toBe("unattended");
    });
  });

  // ── the retry hop ─────────────────────────────────────────────────────
  // A retry is stamped `manual` because a person clicked retry. The work it
  // re-runs can still be a scheduled fire.
  describe("retry", () => {
    it("inherits unattended from the SCHEDULED run it retries", async () => {
      const store = new InMemoryWorkflowStore();
      await seedRun(store, "original", { input: trigger("schedule") });
      const retry = await seedRun(store, "retry", { input: trigger("manual"), retryOf: "original" });
      expect(await resolveRunPresence(store, retry)).toBe("unattended");
    });

    it("stays attended when it retries a MANUAL run", async () => {
      const store = new InMemoryWorkflowStore();
      await seedRun(store, "original", { input: trigger("manual") });
      const retry = await seedRun(store, "retry", { input: trigger("manual"), retryOf: "original" });
      expect(await resolveRunPresence(store, retry)).toBe("attended");
    });

    it("is unattended when the retried run is gone", async () => {
      const store = new InMemoryWorkflowStore();
      const retry = await seedRun(store, "retry", { input: trigger("manual"), retryOf: "missing" });
      expect(await resolveRunPresence(store, retry)).toBe("unattended");
    });
  });

  // ── the two links stack ───────────────────────────────────────────────
  // A person retries a scheduled run, and the retry fans out. The retry is
  // stamped `manual`, so reading only the immediate link calls the child
  // attended while the retry itself is unattended — the fan-out hole.
  describe("a sub-workflow child of a retried run", () => {
    it("inherits unattended from the SCHEDULED run at the start of the chain", async () => {
      const store = new InMemoryWorkflowStore();
      await seedRun(store, "original", { input: trigger("schedule") });
      await seedRun(store, "retry", { input: trigger("manual"), retryOf: "original" });
      const child = await seedRun(store, "child", { input: trigger("workflow"), parentRunId: "retry" });

      expect(await resolveRunPresence(store, child)).toBe("unattended");
      // The child and the run it belongs to must agree, or the same GitHub
      // node runs as two identities inside one retry.
      const retry = await store.getRun("retry");
      if (retry === null) throw new Error("retry run missing");
      expect(await resolveRunPresence(store, retry)).toBe("unattended");
    });

    it("stays attended when the chain starts at a MANUAL run", async () => {
      const store = new InMemoryWorkflowStore();
      await seedRun(store, "original", { input: trigger("manual") });
      await seedRun(store, "retry", { input: trigger("manual"), retryOf: "original" });
      const child = await seedRun(store, "child", { input: trigger("workflow"), parentRunId: "retry" });
      expect(await resolveRunPresence(store, child)).toBe("attended");
    });

    it("is unattended when a run part way along the chain is gone", async () => {
      const store = new InMemoryWorkflowStore();
      await seedRun(store, "retry", { input: trigger("manual"), retryOf: "missing" });
      const child = await seedRun(store, "child", { input: trigger("workflow"), parentRunId: "retry" });
      expect(await resolveRunPresence(store, child)).toBe("unattended");
    });
  });

  // ── the walk is bounded ───────────────────────────────────────────────
  it("reads the run at the start of a two-link chain", async () => {
    const store = new InMemoryWorkflowStore();
    // Nesting depth is capped at 1 in production, so this exact shape cannot
    // occur. It pins that the walk spends its whole budget and reads the run
    // that carries no further link.
    await seedRun(store, "grandparent", { input: trigger("manual") });
    await seedRun(store, "parent", { input: trigger("workflow"), parentRunId: "grandparent" });
    const child = await seedRun(store, "child", { input: trigger("workflow"), parentRunId: "parent" });
    expect(await resolveRunPresence(store, child)).toBe("attended");
  });

  it("stops at the hop cap and answers unattended, not with a half-read chain", async () => {
    const store = new InMemoryWorkflowStore();
    // One link deeper than the cap. The run the walk stops on still carries
    // a link, so its own `manual` says nothing about what started the work.
    await seedRun(store, "great-grandparent", { input: trigger("schedule") });
    await seedRun(store, "grandparent", { input: trigger("manual"), retryOf: "great-grandparent" });
    await seedRun(store, "parent", { input: trigger("workflow"), parentRunId: "grandparent" });
    const child = await seedRun(store, "child", { input: trigger("workflow"), parentRunId: "parent" });
    expect(await resolveRunPresence(store, child)).toBe("unattended");
  });

  it("terminates on a self-referential link instead of looping", async () => {
    const store = new InMemoryWorkflowStore();
    const run = await seedRun(store, "loop", { input: trigger("workflow"), parentRunId: "loop" });
    expect(await resolveRunPresence(store, run)).toBe("unattended");
  });

  it("terminates on a two-run cycle instead of looping", async () => {
    const store = new InMemoryWorkflowStore();
    await seedRun(store, "b", { input: trigger("workflow"), parentRunId: "a" });
    const a = await seedRun(store, "a", { input: trigger("workflow"), parentRunId: "b" });
    expect(await resolveRunPresence(store, a)).toBe("unattended");
  });
});
