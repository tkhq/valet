import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadCases, parseEvalCase } from "../src/case-loader.js";
import { runDeterministicCheck } from "../src/checks/deterministic.js";
import { firstFullDraft, selectorMatches, workflowDrafts, workflowRuleFailures } from "../src/checks/workflow.js";
import { evalGateAnswer, EVAL_QUESTION_ANSWER } from "../src/product-drive.js";
import { formatMetrics } from "../src/scorecard.js";
import type { ScorecardEntry, Trajectory, TrajectoryToolCall, WorkflowDefinitionCheck } from "../src/index.js";

const CHECK: WorkflowDefinitionCheck = { type: "workflow_definition" };

/** A valid lead-update workflow: approval, then a tool write, then a tool read. */
function leadWorkflow(): Record<string, unknown> {
  return {
    version: "dag/v1",
    nodes: [
      { id: "start", type: "trigger", dataSchema: { messageId: { type: "string", required: true } } },
      {
        id: "propose",
        type: "llm",
        model: "s",
        prompt: "Propose a lead update from message {{trigger.data.messageId}}.",
        outputSchema: { type: "object", properties: { stage: { type: "string" } }, required: ["stage"] },
      },
      { id: "gate", type: "approval", prompt: "Apply stage {{nodes.propose.result.output.stage}}?" },
      {
        id: "write",
        type: "tool",
        service: "google_workspace",
        action: "sheets.write_spreadsheet",
        params: { spreadsheetId: "sheet-1", range: "Leads!D2", data: [["{{nodes.propose.result.output.stage}}"]] },
      },
      {
        id: "verify",
        type: "tool",
        service: "google_workspace",
        action: "sheets.read_spreadsheet",
        params: { spreadsheetId: "sheet-1", range: "Leads!D2" },
      },
      { id: "done", type: "stop", outcome: "success" },
    ],
    edges: [
      { from: "start", to: "propose" },
      { from: "propose", to: "gate" },
      { from: "gate", to: "write" },
      { from: "write", to: "verify" },
      { from: "verify", to: "done" },
    ],
  };
}

function withNode(definition: Record<string, unknown>, id: string, patch: Record<string, unknown>): Record<string, unknown> {
  const nodes = (definition.nodes as Array<Record<string, unknown>>).map((node) => (node.id === id ? { ...node, ...patch } : node));
  return { ...definition, nodes };
}

function saveCall(index: number, definition: unknown, ok: boolean): TrajectoryToolCall {
  const text = ok ? "workflowId: wf_1" : "workflows.save_workflow failed: workflow definition failed validation";
  return {
    toolName: "call_tool",
    callId: `c${index}`,
    status: "completed",
    index,
    actionId: "workflows.save_workflow",
    args: { tool_id: "workflows.save_workflow", params: { definition } },
    result: { content: [{ type: "text", text }], details: { ok } },
  };
}

function trajectory(toolCalls: TrajectoryToolCall[], metadata?: Record<string, unknown>): Trajectory {
  return {
    caseId: "t",
    prompt: "p",
    model: "m",
    turns: [{ index: 0 }],
    toolCalls,
    finalOutput: "saved",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
    durationMs: 1,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

describe("workflow drafts", () => {
  it("reads definitions from call_tool and pinned calls and marks rejections", () => {
    const pinned: TrajectoryToolCall = {
      toolName: "workflows__validate_definition",
      callId: "c2",
      status: "completed",
      index: 2,
      actionId: "workflows.validate_definition",
      args: { definition: leadWorkflow() },
      result: { text: "valid: true", details: { ok: true } },
    };
    const drafts = workflowDrafts(trajectory([saveCall(0, { nodes: [] }, false), pinned]));
    expect(drafts.map((draft) => [draft.callIndex, draft.rejected])).toEqual([
      [0, true],
      [2, false],
    ]);
  });
});

describe("workflow_definition", () => {
  it("passes a correct draft and reports first-draft correctness", () => {
    const r = runDeterministicCheck(CHECK, trajectory([saveCall(0, leadWorkflow(), true)]));
    expect(r.pass).toBe(true);
    expect(r.metrics).toEqual({
      drafts: 1,
      probes: 0,
      rejections: 0,
      unknown_tool_calls: 0,
      first_valid: true,
      first_correct: true,
      final_valid: true,
    });
  });

  it("keeps repair effort apart from the final verdict", () => {
    const broken = withNode(leadWorkflow(), "done", { outcome: "completed" });
    const r = runDeterministicCheck(CHECK, trajectory([saveCall(0, broken, false), saveCall(1, leadWorkflow(), true)]));
    expect(r.pass).toBe(true);
    expect(r.metrics).toMatchObject({ drafts: 2, rejections: 1, first_valid: false, first_correct: false });
    expect(r.detail).toContain("1 validator rejection");
  });

  it("scores the saved definition over the last draft", () => {
    const broken = withNode(leadWorkflow(), "done", { outcome: "completed" });
    const r = runDeterministicCheck(
      CHECK,
      trajectory([saveCall(0, leadWorkflow(), true)], { savedWorkflows: [{ id: "wf_1", definition: broken }] }),
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("saved definition");
    expect(r.detail).toContain('"completed"');
  });

  it("does not score a call to a tool that does not exist", () => {
    const unknown: TrajectoryToolCall = {
      toolName: "workflows__validate_definition",
      callId: "c0",
      status: "error",
      index: 0,
      actionId: "workflows.validate_definition",
      args: { definition: JSON.stringify(leadWorkflow()) },
      result: { content: [{ type: "text", text: "Tool workflows__validate_definition not found" }], details: {} },
    };
    const t = trajectory([unknown, saveCall(1, leadWorkflow(), true)]);
    expect(workflowDrafts(t).map((draft) => draft.callIndex)).toEqual([1]);
    const r = runDeterministicCheck(CHECK, t);
    expect(r.metrics).toMatchObject({ drafts: 1, rejections: 0, unknown_tool_calls: 1, first_correct: true });
    expect(r.detail).toContain("1 call(s) to a tool that does not exist");
  });

  it("scores the first full draft, not a probe before it", () => {
    const probe = {
      version: "dag/v1",
      nodes: [
        { id: "start", type: "trigger" },
        { id: "done", type: "stop", outcome: "success" },
      ],
      edges: [{ from: "start", to: "done" }],
    };
    const check: WorkflowDefinitionCheck = { ...CHECK, approved_actions: ["sheets.write_spreadsheet"] };
    const r = runDeterministicCheck(check, trajectory([saveCall(0, probe, true), saveCall(1, leadWorkflow(), true)]));
    expect(r.metrics).toMatchObject({ drafts: 2, probes: 1, first_correct: true });
    expect(r.detail).toContain("1 probe(s)");
  });

  it("treats the final definition as the first full draft when every draft is small", () => {
    const small = { version: "dag/v1", nodes: [{ id: "start", type: "trigger" }], edges: [] };
    expect(firstFullDraft([{ definition: small, callIndex: 0, rejected: false }], leadWorkflow(), true)).toEqual({
      definition: leadWorkflow(),
      valid: true,
      probes: 1,
    });
  });

  it("takes validity from the product's save results, not from a second validator", () => {
    // The product refused the first draft, for example on an org rule the eval cannot see.
    const refusedFirst = runDeterministicCheck(
      CHECK,
      trajectory([saveCall(0, leadWorkflow(), false), saveCall(1, leadWorkflow(), true)], {
        savedWorkflows: [{ id: "wf_1", definition: leadWorkflow() }],
      }),
    );
    expect(refusedFirst.metrics).toMatchObject({ first_valid: false, first_correct: false, final_valid: true });
    // A product action outside the bundled plugins is valid once the product saved it.
    const listStep = withNode(leadWorkflow(), "verify", { service: "workflows", action: "list_workflows", params: {} });
    const saved = runDeterministicCheck(
      CHECK,
      trajectory([saveCall(0, listStep, true)], { savedWorkflows: [{ id: "wf_1", definition: listStep }] }),
    );
    expect(saved.pass).toBe(true);
    expect(saved.metrics).toMatchObject({ first_valid: true, final_valid: true });
  });

  it("fails when the agent saved more than one workflow", () => {
    const helper = {
      version: "dag/v1",
      nodes: [
        { id: "start", type: "trigger" },
        { id: "done", type: "stop", outcome: "success" },
      ],
      edges: [{ from: "start", to: "done" }],
    };
    const r = runDeterministicCheck(
      CHECK,
      trajectory([saveCall(0, leadWorkflow(), true), saveCall(1, helper, true)], {
        savedWorkflows: [
          { id: "wf_1", definition: leadWorkflow() },
          { id: "wf_2", definition: helper },
        ],
      }),
    );
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("the agent saved 2 workflows; the case asks for one");
  });

  it("fails a saved: true case when the save stored nothing", () => {
    const check: WorkflowDefinitionCheck = { ...CHECK, saved: true };
    const rejectedSave = saveCall(0, leadWorkflow(), false);
    const r = runDeterministicCheck(check, trajectory([rejectedSave]));
    expect(r.pass).toBe(false);
    expect(r.detail).toContain("no workflow was saved");
    const stored = runDeterministicCheck(check, trajectory([saveCall(0, leadWorkflow(), true)], { savedWorkflows: [{ id: "wf_1", definition: leadWorkflow() }] }));
    expect(stored.pass).toBe(true);
  });

  it("fails when the agent drafted nothing", () => {
    const r = runDeterministicCheck(CHECK, trajectory([]));
    expect(r.pass).toBe(false);
    expect(r.metrics).toMatchObject({ drafts: 0, final_valid: false });
  });
});

describe("workflow rules", () => {
  it("flags a foreach without an inline body or maxItems", () => {
    const definition = {
      version: "dag/v1",
      nodes: [
        { id: "start", type: "trigger" },
        { id: "each", type: "foreach", items: "{{trigger.data.items}}", body: ["draft"] },
      ],
      edges: [{ from: "start", to: "each" }],
    };
    expect(workflowRuleFailures(definition, CHECK)).toEqual([
      'foreach step "each" has no inline body object',
      'foreach step "each" sets no maxItems',
    ]);
  });

  it("flags an agent prompt that asks for approval, including a foreach body", () => {
    const definition = {
      version: "dag/v1",
      nodes: [
        { id: "start", type: "trigger" },
        {
          id: "each",
          type: "foreach",
          items: "{{trigger.data.items}}",
          maxItems: 10,
          body: { id: "act", type: "orchestrator", prompt: "Ask the owner for approval, then update the row." },
        },
      ],
      edges: [{ from: "start", to: "each" }],
    };
    expect(workflowRuleFailures(definition, CHECK)).toEqual(['agent step "act" tells its agent to get approval']);
  });

  it("requires approved actions in tool steps and out of agent scopes", () => {
    const check: WorkflowDefinitionCheck = { ...CHECK, approved_actions: ["sheets.write_spreadsheet"] };
    expect(workflowRuleFailures(leadWorkflow(), check)).toEqual([]);

    const agentWrite = withNode(leadWorkflow(), "write", {
      type: "orchestrator",
      prompt: "Write the stage to the sheet.",
      toolScope: { actions: ["sheets.*"] },
    });
    expect(workflowRuleFailures(agentWrite, check)).toEqual([
      "no tool step runs sheets.write_spreadsheet",
      'agent step "write" can run sheets.*; an approved action belongs in a tool step',
    ]);
  });

  it("treats an agent step without toolScope.actions as able to run an approved action", () => {
    const check: WorkflowDefinitionCheck = { ...CHECK, approved_actions: ["sheets.write_spreadsheet"] };
    const unscoped = withNode(leadWorkflow(), "propose", { type: "orchestrator", model: undefined, prompt: "Propose a lead update." });
    expect(workflowRuleFailures(unscoped, check)).toEqual([
      'agent step "propose" sets no toolScope.actions, so it can run sheets.write_spreadsheet; an approved action belongs in a tool step',
    ]);
    const readsOnly = withNode(unscoped, "propose", { toolScope: { actions: ["gmail.*", "sheets.read_spreadsheet"] } });
    expect(workflowRuleFailures(readsOnly, check)).toEqual([]);
  });

  it("checks step order along edges", () => {
    const check: WorkflowDefinitionCheck = { ...CHECK, order: ["approval", "sheets.write_*", "sheets.read_spreadsheet"] };
    expect(workflowRuleFailures(leadWorkflow(), check)).toEqual([]);

    const writeFirst = {
      ...leadWorkflow(),
      edges: [
        { from: "start", to: "propose" },
        { from: "propose", to: "write" },
        { from: "write", to: "gate" },
        { from: "gate", to: "verify" },
        { from: "verify", to: "done" },
      ],
    };
    expect(workflowRuleFailures(writeFirst, check)).toEqual([
      'step "write" matches sheets.write_* and can run before the approval',
      "no step that matches sheets.write_* runs after one that matches approval",
    ]);
  });

  it("does not count a step on an approval's denial branch as after the approval", () => {
    const check: WorkflowDefinitionCheck = { ...CHECK, order: ["approval", "sheets.write_*", "sheets.read_spreadsheet"] };
    const failure = [
      'step "write" matches sheets.write_* and can run before the approval',
      "no step that matches sheets.write_* runs after one that matches approval",
    ];
    const withGateEdge = (definition: Record<string, unknown>, edge: Record<string, unknown>): Record<string, unknown> => ({
      ...definition,
      edges: (definition.edges as Array<Record<string, unknown>>).map((e) => (e.from === "gate" ? { ...e, ...edge } : e)),
    });

    expect(workflowRuleFailures(withGateEdge(leadWorkflow(), { fromOutput: "false" }), check)).toEqual(failure);
    const skip = withNode(leadWorkflow(), "gate", { onDeny: "skip" });
    expect(workflowRuleFailures(skip, check)).toEqual(failure);
    expect(workflowRuleFailures(withGateEdge(skip, { fromOutput: "true" }), check)).toEqual([]);
  });

  it("fails a matching write that can run before the approval, but allows an earlier read", () => {
    const check: WorkflowDefinitionCheck = { ...CHECK, order: ["approval", "sheets.write_*", "sheets.read_spreadsheet"] };
    const base = leadWorkflow();
    const extra = (id: string, action: string): Record<string, unknown> => ({
      id,
      type: "tool",
      service: "google_workspace",
      action,
      params: action === "sheets.write_spreadsheet"
        ? { spreadsheetId: "sheet-1", range: "Leads!D2", data: [["early"]] }
        : { spreadsheetId: "sheet-1", range: "Leads!A2:F2" },
    });
    const before = (node: Record<string, unknown>): Record<string, unknown> => ({
      ...base,
      nodes: [...(base.nodes as unknown[]), node],
      edges: [
        { from: "start", to: node.id },
        { from: node.id, to: "propose" },
        ...(base.edges as Array<Record<string, unknown>>).filter((edge) => edge.from !== "start"),
      ],
    });
    expect(workflowRuleFailures(before(extra("early_write", "sheets.write_spreadsheet")), check)).toEqual([
      'step "early_write" matches sheets.write_* and can run before the approval',
    ]);
    expect(workflowRuleFailures(before(extra("lookup", "sheets.read_spreadsheet")), check)).toEqual([]);
  });

  it("reads bracket notation like dotted notation", () => {
    const check: WorkflowDefinitionCheck = { ...CHECK, schedule_input: true, run_date: true };
    const bracketed = withNode(leadWorkflow(), "propose", {
      prompt: 'Rates for {{trigger["data"]["input"].symbols}} on {{trigger["timestamp"]}}.',
    });
    expect(workflowRuleFailures(bracketed, check)).toEqual([]);
  });

  it("requires schedule input reads under trigger.data.input", () => {
    const check: WorkflowDefinitionCheck = { ...CHECK, schedule_input: true };
    const scheduled = withNode(leadWorkflow(), "propose", { prompt: "Rates for {{trigger.data.input.symbols}}." });
    expect(workflowRuleFailures(scheduled, check)).toEqual([]);
    const named = withNode(leadWorkflow(), "propose", {
      prompt: "Rates for {{trigger.data.input.symbols}} from {{trigger.data.scheduleName}} ({{trigger.data.cron}}).",
    });
    expect(workflowRuleFailures(named, check)).toEqual([]);
    expect(workflowRuleFailures(leadWorkflow(), check)).toEqual([
      "no step reads the schedule input at trigger.data.input",
      "steps read trigger.data.messageId; schedule input is at trigger.data.input",
    ]);
  });

  it("requires trigger.timestamp and no literal date for the run date", () => {
    const check: WorkflowDefinitionCheck = { ...CHECK, run_date: true };
    expect(workflowRuleFailures(leadWorkflow(), check)).toEqual(["no step reads the run date from trigger.timestamp"]);
    const dated = withNode(leadWorkflow(), "propose", { prompt: "Rates for 2026-10-20 and {{trigger.timestamp}}." });
    expect(workflowRuleFailures(dated, check)).toEqual(["steps propose hold a literal date"]);
  });

  it("requires a dataSchema entry for each trigger.data field", () => {
    const check: WorkflowDefinitionCheck = { ...CHECK, declared_inputs: true };
    expect(workflowRuleFailures(leadWorkflow(), check)).toEqual([]);
    const undeclared = withNode(leadWorkflow(), "start", { dataSchema: undefined });
    expect(workflowRuleFailures(undeclared, check)).toEqual(["the trigger dataSchema does not declare messageId"]);
  });

  it("matches selectors against tool actions, foreach tool bodies, and step types", () => {
    const tool = { id: "w", type: "tool", service: "github", action: "create_issue", params: {} };
    expect(selectorMatches("github.create_*", tool)).toBe(true);
    expect(selectorMatches("approval|github.create_issue", tool)).toBe(true);
    expect(selectorMatches("github.create_issue", { id: "e", type: "foreach", items: "x", body: tool })).toBe(true);
    expect(selectorMatches("approval", { id: "g", type: "approval" })).toBe(true);
    expect(selectorMatches("github.create_issue", { id: "o", type: "orchestrator", prompt: "x" })).toBe(false);
  });
});

describe("workflow case files", () => {
  it("load from evals/cases/workflows", async () => {
    const cases = await loadCases(join(import.meta.dirname, "../../../evals/cases/workflows"));
    expect(cases.map((c) => c.id).sort()).toEqual([
      "workflow-bot-alert-triage",
      "workflow-onboarding-linear",
      "workflow-release-report",
      "workflow-sales-tracker",
      "workflow-scheduled-refresh",
    ]);
    for (const c of cases) {
      expect(c.drive).toBe("product");
      expect(c.checks.some((check) => check.type === "workflow_definition")).toBe(true);
    }
  });

  it("keep every sheet-changing action in the sales case behind the approval", async () => {
    const cases = await loadCases(join(import.meta.dirname, "../../../evals/cases/workflows"));
    const check = cases
      .find((c) => c.id === "workflow-sales-tracker")
      ?.checks.find((k): k is WorkflowDefinitionCheck => k.type === "workflow_definition");
    if (check === undefined) throw new Error("the sales case has no workflow_definition check");
    expect(workflowRuleFailures(leadWorkflow(), check)).toEqual([]);

    const append = { id: "log", type: "tool", service: "google_workspace", action: "sheets.append_rows", params: {} };
    const appendFirst = {
      ...leadWorkflow(),
      nodes: [...(leadWorkflow().nodes as Array<Record<string, unknown>>), append],
      edges: [
        { from: "start", to: "log" },
        { from: "log", to: "propose" },
        ...(leadWorkflow().edges as Array<Record<string, unknown>>).filter((edge) => edge.from !== "start"),
      ],
    };
    expect(workflowRuleFailures(appendFirst, check).join("\n")).toContain('step "log" matches sheets.*');

    const scoped = withNode(leadWorkflow(), "propose", {
      type: "orchestrator",
      model: undefined,
      prompt: "Propose a lead update.",
      toolScope: { actions: ["gmail.*", "sheets.read_spreadsheet", "sheets.append_rows"] },
    });
    expect(workflowRuleFailures(scoped, check)).toEqual([
      'agent step "propose" can run sheets.append_rows; an approved action belongs in a tool step',
    ]);
  });

  it("rejects connected outside the product drive", () => {
    const raw = {
      id: "x",
      connected: ["github"],
      turns: [{ role: "user", content: "hi" }],
      checks: [{ type: "no_errors" }],
    };
    expect(() => parseEvalCase(raw, "x.yaml")).toThrow(/connected/);
  });
});

describe("product-drive decision answers", () => {
  it("answers a question with the fixed text and declines other cards", () => {
    expect(evalGateAnswer({ id: "g1", type: "question", title: "Which repo?", actions: [{ id: "option-0" }] })).toEqual({
      value: EVAL_QUESTION_ANSWER,
    });
    expect(
      evalGateAnswer({
        id: "g2",
        type: "approval",
        title: "Allow",
        actions: [
          { id: "approve", style: "primary" },
          { id: "cancel" },
        ],
      }),
    ).toEqual({ actionId: "cancel" });
  });
});

describe("formatMetrics", () => {
  const base: ScorecardEntry = { caseId: "c", status: "pass", durationMs: 1, checkResults: [] };

  it("prints one run's metrics", () => {
    const entry: ScorecardEntry = {
      ...base,
      checkResults: [{ check: CHECK, pass: true, metrics: { rejections: 2, first_correct: false } }],
    };
    expect(formatMetrics(entry)).toBe("rejections 2, first_correct no");
  });

  it("aggregates per-run metrics", () => {
    const entry: ScorecardEntry = {
      ...base,
      sampling: {
        runs: 2,
        passes: 2,
        threshold: 1,
        tokensPerRun: [1, 1],
        tokensMean: 1,
        tokensStd: 0,
        metricsPerRun: [
          { rejections: 1, first_correct: true },
          { rejections: 2, first_correct: false },
        ],
      },
    };
    expect(formatMetrics(entry)).toBe("per run: rejections mean 1.5, first_correct 1/2");
  });
});
