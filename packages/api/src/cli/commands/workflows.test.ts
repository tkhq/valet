import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { ExitCode } from "../exit.js";
import { parseGlobalFlags } from "../output.js";
import { runWorkflows, type WorkflowsClient } from "./workflows.js";
import type { GetWorkflowRunResponse, WorkflowPendingGate, WorkflowRunOutcome, WorkflowRunStatus } from "../../wire/types.js";

let errSpy: MockInstance;
beforeEach(() => {
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());
const stderr = (): string => errSpy.mock.calls.map((c) => String(c[0])).join("");

const gate: WorkflowPendingGate = { nodeId: "call", kind: "policy_gate", service: "demo", action: "risky" };

function detail(status: WorkflowRunStatus, outcome?: WorkflowRunOutcome, gates: WorkflowPendingGate[] = []): GetWorkflowRunResponse {
  return {
    run: { runId: "r1", workflowId: "w1", status, ...(outcome ? { outcome } : {}), createdAt: 1, updatedAt: 1, waitingOn: [], definition: null, params: null },
    owner: { type: "user", id: "u1" },
    checkpoints: [],
    signals: [],
    pendingGates: gates,
  };
}

/** A client whose run reads return `reads` in order, repeating the last one. */
function fake(reads: GetWorkflowRunResponse[]) {
  const calls: string[] = [];
  let i = 0;
  const client: WorkflowsClient = {
    listWorkflows: async () => ({ workflows: [] }),
    startWorkflowRun: async (id, input) => {
      calls.push(`start ${id} ${JSON.stringify(input ?? null)}`);
      return { runId: "r1" };
    },
    getWorkflowRun: async () => reads[Math.min(i++, reads.length - 1)] ?? detail("running"),
    cancelWorkflowRun: async (id) => { calls.push(`cancel ${id}`); },
    retryWorkflowRun: async (id) => { calls.push(`retry ${id}`); return { runId: "r2" }; },
  };
  let clock = 0;
  return { calls, deps: { client, readSource: async () => "", sleep: async (ms: number) => { clock += ms; }, now: () => clock } };
}

const run = (deps: Parameters<typeof runWorkflows>[0], args: string[]) => runWorkflows(deps, parseGlobalFlags(args));

describe("valet workflows", () => {
  it("run passes --input and maps the settled outcome to an exit code", async () => {
    const { deps, calls } = fake([detail("running"), detail("settled", "completed")]);
    expect(await run(deps, ["run", "w1", "--input", '{"env":"staging"}', "--wait", "30"])).toBe(ExitCode.OK);
    expect(calls).toEqual(['start w1 {"env":"staging"}']);
    expect(await run(fake([detail("settled", "failed")]).deps, ["run", "w1", "--wait", "5"])).toBe(ExitCode.TurnError);
  });

  it("run without --wait reports the current status and exits 3 while it runs", async () => {
    expect(await run(fake([detail("running")]).deps, ["run", "w1"])).toBe(ExitCode.GatePending);
  });

  it("stops waiting when the run parks on an approval, and exits 3", async () => {
    expect(await run(fake([detail("parked", undefined, [gate])]).deps, ["run", "w1", "--wait", "30"])).toBe(ExitCode.GatePending);
  });

  it("rejects --input that is not a JSON object, even one with an error key it must keep", async () => {
    expect(await run(fake([]).deps, ["run", "w1", "--input", "[1]"])).toBe(ExitCode.Usage);
    expect(stderr()).toContain("--input must be a JSON object");
    const { deps, calls } = fake([detail("settled", "completed")]);
    expect(await run(deps, ["run", "w1", "--input", '{"error":"kept"}'])).toBe(ExitCode.OK);
    expect(calls).toEqual(['start w1 {"error":"kept"}']);
  });

  // The gate a cancel ends stays pending until the run settles, so the wait must not stop on it.
  // A failed status read must not hide the id of a run that already started:
  // a script that retries would start a second, side-effecting run.
  it("names the new run on stderr before a status read can fail", async () => {
    const { deps } = fake([]);
    deps.client.getWorkflowRun = async () => { throw new Error("connection reset"); };
    await expect(run(deps, ["run", "w1", "--wait", "30"])).rejects.toThrow("connection reset");
    expect(stderr()).toContain("started r1");
    expect(stderr()).toContain("valet workflows status r1");
  });

  it("refuses an explicitly empty --input instead of running with defaults", async () => {
    const { deps, calls } = fake([detail("settled", "completed")]);
    expect(await run(deps, ["run", "w1", "--input", ""])).toBe(ExitCode.Usage);
    expect(calls).toEqual([]);
  });

  it("cancel does not exit 0 when the run completed before the cancel took effect", async () => {
    const { deps } = fake([detail("settled", "completed")]);
    expect(await run(deps, ["cancel", "r1"])).toBe(ExitCode.TurnError);
    expect(stderr()).toContain("settled as completed before the cancel took effect");
  });

  it("cancel waits past the pending gate for the run to settle, and exits 0 when cancelled", async () => {
    const { deps, calls } = fake([detail("terminalizing", undefined, [gate]), detail("settled", "cancelled")]);
    expect(await run(deps, ["cancel", "r1"])).toBe(ExitCode.OK);
    expect(calls).toEqual(["cancel r1"]);
  });

  it("retry follows the new run id", async () => {
    const { deps, calls } = fake([detail("settled", "completed")]);
    expect(await run(deps, ["retry", "r1", "--wait", "5"])).toBe(ExitCode.OK);
    expect(calls).toEqual(["retry r1"]);
  });
});
