import { describe, expect, it } from "vitest";
import type { WorkflowPendingGate } from "@valet/api/wire";
import {
  deriveRunResult,
  findApprovalPrompt,
  findPendingApproval,
  formatRunDuration,
  formatRunOutput,
  jsonPreview,
  readTemplateDiagnostics,
  runNeedsApproval,
  statusByNodeId,
} from "./run-detail-helpers";

describe("statusByNodeId", () => {
  it("maps checkpoints + waitingOn to per-node statuses", () => {
    const { status } = statusByNodeId(
      {
        status: "parked",
        waitingOn: [{ kind: "signal", nodeId: "gate1", signalType: "approval:gate1" }],
      },
      [
        { nodeId: "t1", iteration: 0, status: "completed" },
        { nodeId: "s1", iteration: 0, status: "failed" },
        { nodeId: "w1", iteration: 0, status: "intent" },
        { nodeId: "sk1", iteration: 0, status: "skipped" },
      ],
    );
    expect(status).toEqual({
      t1: "succeeded",
      s1: "failed",
      w1: "running",
      sk1: "skipped",
      gate1: "waiting",
    });
  });

  it("aggregates multi-iteration nodes and emits a progress badge", () => {
    const { status, badges } = statusByNodeId({ status: "running" }, [
      { nodeId: "body", iteration: 0, status: "completed" },
      { nodeId: "body", iteration: 1, status: "completed" },
      { nodeId: "body", iteration: 2, status: "intent" },
    ]);
    expect(status.body).toBe("running");
    expect(badges.body).toBe("2/3");
  });

  it("any failed iteration marks the node failed", () => {
    const { status } = statusByNodeId({ status: "settled" }, [
      { nodeId: "body", iteration: 0, status: "completed" },
      { nodeId: "body", iteration: 1, status: "failed" },
    ]);
    expect(status.body).toBe("failed");
  });
});

describe("findPendingApproval", () => {
  it("finds an approval signal wait condition", () => {
    const waitingOn = [{ kind: "signal", nodeId: "deploy", signalType: "approval:deploy" }];
    expect(findPendingApproval(waitingOn)).toEqual({ nodeId: "deploy", signalType: "approval:deploy" });
  });

  it("ignores timer/submission waits and non-approval signals", () => {
    const waitingOn = [
      { kind: "timer", nodeId: "wait1", wakeAt: 123 },
      { kind: "signal", nodeId: "cancel-wait", signalType: "cancel" },
    ];
    expect(findPendingApproval(waitingOn)).toBeUndefined();
  });

  it("returns undefined for an empty waitingOn", () => {
    expect(findPendingApproval([])).toBeUndefined();
  });
});

describe("findApprovalPrompt", () => {
  const definition = {
    version: "dag/v1",
    nodes: [
      { id: "trigger", type: "trigger" },
      { id: "deploy", type: "approval", prompt: "Ship it?" },
    ],
    edges: [],
  };

  it("finds the prompt for a matching approval node", () => {
    expect(findApprovalPrompt(definition, "deploy")).toBe("Ship it?");
  });

  it("returns undefined for an unknown node id", () => {
    expect(findApprovalPrompt(definition, "nope")).toBeUndefined();
  });

  it("returns undefined for a malformed definition", () => {
    expect(findApprovalPrompt(null, "deploy")).toBeUndefined();
    expect(findApprovalPrompt({ nodes: "not-an-array" }, "deploy")).toBeUndefined();
  });
});

describe("runNeedsApproval", () => {
  const gate: WorkflowPendingGate = { nodeId: "deploy", kind: "approval" };

  it("returns true when status is parked and there is at least one pending gate", () => {
    expect(runNeedsApproval({ status: "parked" }, [gate])).toBe(true);
  });

  it("returns false when parked but no pending gates", () => {
    expect(runNeedsApproval({ status: "parked" }, [])).toBe(false);
  });

  it("returns false when parked but pendingGates is undefined", () => {
    expect(runNeedsApproval({ status: "parked" }, undefined)).toBe(false);
  });

  it("returns false when status is not parked even with gates", () => {
    expect(runNeedsApproval({ status: "running" }, [gate])).toBe(false);
    expect(runNeedsApproval({ status: "settled" }, [gate])).toBe(false);
  });
});

describe("jsonPreview", () => {
  it("returns empty string for undefined", () => {
    expect(jsonPreview(undefined)).toBe("");
  });

  it("pretty-prints small values in full", () => {
    expect(jsonPreview({ a: 1 })).toBe('{\n  "a": 1\n}');
  });

  it("truncates long values with an ellipsis", () => {
    const big = { text: "a".repeat(1000) };
    const preview = jsonPreview(big, 50);
    expect(preview.length).toBeLessThanOrEqual(51);
    expect(preview.endsWith("…")).toBe(true);
  });
});

describe("deriveRunResult", () => {
  const definition = {
    version: "dag/v1",
    nodes: [
      { id: "fetch", type: "tool" },
      { id: "done", type: "stop" },
    ],
    edges: [],
  };

  it("returns undefined while the run is still in flight", () => {
    expect(deriveRunResult({ status: "running", definition }, [])).toBeUndefined();
    expect(deriveRunResult({ status: "parked", definition }, [])).toBeUndefined();
  });

  it("returns undefined for a settled run with no recorded outcome", () => {
    expect(deriveRunResult({ status: "settled", definition }, [])).toBeUndefined();
  });

  it("reads the stop node's message and output off its checkpoint", () => {
    const result = deriveRunResult({ status: "settled", outcome: "completed", definition }, [
      { nodeId: "fetch", iteration: 0, status: "completed", result: { rows: 3 }, createdAt: 1 },
      {
        nodeId: "done",
        iteration: 0,
        status: "completed",
        result: { outcome: "success", message: "Opened 3 issues.", output: { count: 3 } },
        createdAt: 2,
      },
    ]);
    expect(result).toEqual({
      outcome: "completed",
      message: "Opened 3 issues.",
      output: { count: 3 },
      nodeId: "done",
      diagnostics: [],
    });
  });

  it("ignores a node that is not a stop node in the definition", () => {
    const result = deriveRunResult({ status: "settled", outcome: "completed", definition }, [
      {
        nodeId: "fetch",
        iteration: 0,
        status: "completed",
        result: { message: "not the answer" },
        createdAt: 1,
      },
    ]);
    expect(result?.message).toBeUndefined();
    expect(result?.nodeId).toBeUndefined();
  });

  it("takes the newest stop checkpoint when the store returns them unordered", () => {
    const result = deriveRunResult({ status: "settled", outcome: "completed", definition }, [
      {
        nodeId: "done",
        iteration: 1,
        status: "completed",
        result: { message: "second" },
        createdAt: 9,
      },
      {
        nodeId: "done",
        iteration: 0,
        status: "completed",
        result: { message: "first" },
        createdAt: 4,
      },
    ]);
    expect(result?.message).toBe("second");
  });

  it("promotes a failure stop node's message as the failure reason", () => {
    const result = deriveRunResult({ status: "settled", outcome: "failed", definition }, [
      {
        nodeId: "done",
        iteration: 0,
        status: "failed",
        error: "The pull request has no reviewer.",
        result: { outcome: "failure", message: "The pull request has no reviewer." },
        createdAt: 2,
      },
    ]);
    expect(result?.outcome).toBe("failed");
    expect(result?.message).toBe("The pull request has no reviewer.");
    expect(result?.nodeId).toBe("done");
  });

  it("falls back to the first failing node when the run never reached a stop node", () => {
    const result = deriveRunResult({ status: "settled", outcome: "failed", definition }, [
      { nodeId: "fetch", iteration: 0, status: "failed", error: "connection refused", createdAt: 5 },
      { nodeId: "other", iteration: 0, status: "failed", error: "later failure", createdAt: 8 },
    ]);
    expect(result?.message).toBe("connection refused");
    expect(result?.nodeId).toBe("fetch");
  });

  it("reports a cancelled run with no message rather than inventing one", () => {
    const result = deriveRunResult({ status: "settled", outcome: "cancelled", definition }, [
      { nodeId: "fetch", iteration: 0, status: "completed", createdAt: 1 },
    ]);
    expect(result).toEqual({
      outcome: "cancelled",
      message: undefined,
      output: undefined,
      nodeId: undefined,
      diagnostics: [],
    });
  });

  it("survives a definition that does not parse", () => {
    expect(
      deriveRunResult({ status: "settled", outcome: "completed", definition: null }, []),
    ).toEqual({
      outcome: "completed",
      message: undefined,
      output: undefined,
      nodeId: undefined,
      diagnostics: [],
    });
  });

  it("collects template diagnostics from the run record and the result body", () => {
    const result = deriveRunResult(
      {
        status: "settled",
        outcome: "completed",
        definition,
        templateDiagnostics: [{ path: "trigger.data.owner", nodeId: "fetch" }],
      },
      [
        {
          nodeId: "done",
          iteration: 0,
          status: "completed",
          result: {
            message: "Done.",
            diagnostics: ["nodes.fetch.response"],
          },
          createdAt: 2,
        },
      ],
    );
    expect(result?.diagnostics).toEqual([
      { path: "trigger.data.owner", nodeId: "fetch" },
      { path: "nodes.fetch.response" },
    ]);
  });

  it("reports no diagnostics for a run recorded before the field existed", () => {
    const result = deriveRunResult({ status: "settled", outcome: "completed", definition }, [
      { nodeId: "done", iteration: 0, status: "completed", result: { message: "ok" }, createdAt: 1 },
    ]);
    expect(result?.diagnostics).toEqual([]);
  });
});

describe("readTemplateDiagnostics", () => {
  it("returns an empty list for anything that carries no diagnostics", () => {
    expect(readTemplateDiagnostics(undefined)).toEqual([]);
    expect(readTemplateDiagnostics(null)).toEqual([]);
    expect(readTemplateDiagnostics("a string")).toEqual([]);
    expect(readTemplateDiagnostics({ templateDiagnostics: "not an array" })).toEqual([]);
  });

  it("accepts plain path strings", () => {
    expect(readTemplateDiagnostics({ unresolvedPaths: ["trigger.data.id", ""] })).toEqual([
      { path: "trigger.data.id" },
    ]);
  });

  it("accepts records and keeps the node and the detail", () => {
    expect(
      readTemplateDiagnostics({
        diagnostics: [{ expression: "nodes.a.data.x", nodeId: "post", reason: "node has no schema" }],
      }),
    ).toEqual([{ path: "nodes.a.data.x", nodeId: "post", detail: "node has no schema" }]);
  });

  it("keeps the field and the suggestion a producer records alongside the path", () => {
    // Shape of `TemplatePathDiagnostic`
    // (`packages/workflow/src/dag/path-diagnostics.ts`).
    expect(
      readTemplateDiagnostics({
        templateDiagnostics: [
          {
            path: "nodes.draft.result.text",
            nodeId: "draft",
            field: "prompt",
            origin: "field",
            failedSegment: "text",
            reason: "missing_key",
            suggestion: "nodes.draft.result.response",
            message: 'No key "text" on the result of node "draft".',
          },
        ],
      }),
    ).toEqual([
      {
        path: "nodes.draft.result.text",
        nodeId: "draft",
        field: "prompt",
        detail: 'No key "text" on the result of node "draft".',
        suggestion: "nodes.draft.result.response",
      },
    ]);
  });

  it("drops an entry with no usable path", () => {
    expect(readTemplateDiagnostics({ diagnostics: [{ nodeId: "post" }, 42, null] })).toEqual([]);
  });
});

describe("formatRunOutput", () => {
  it("returns undefined when there is nothing to show", () => {
    expect(formatRunOutput(undefined)).toBeUndefined();
    expect(formatRunOutput(null)).toBeUndefined();
    expect(formatRunOutput("")).toBeUndefined();
  });

  it("keeps a string output as prose", () => {
    expect(formatRunOutput("all clear")).toEqual({ kind: "text", text: "all clear" });
  });

  it("renders structured output as JSON", () => {
    expect(formatRunOutput({ ok: true })).toEqual({ kind: "json", text: '{\n  "ok": true\n}' });
  });

  it("falls back to text for a value JSON cannot serialize", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(formatRunOutput(cyclic)?.kind).toBe("text");
  });
});

describe("formatRunDuration", () => {
  it("scales the unit to the length of the run", () => {
    expect(formatRunDuration(0, 850)).toBe("850ms");
    expect(formatRunDuration(0, 4200)).toBe("4.2s");
    expect(formatRunDuration(0, 3 * 60_000 + 4000)).toBe("3m 04s");
    expect(formatRunDuration(0, 60 * 60_000 + 5 * 60_000)).toBe("1h 05m");
  });

  it("returns undefined when the timestamps cannot give an answer", () => {
    expect(formatRunDuration(100, 50)).toBeUndefined();
    expect(formatRunDuration(Number.NaN, 50)).toBeUndefined();
  });
});
