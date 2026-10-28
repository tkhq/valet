import { expect, it } from "vitest";
import { workflowRunThreadKey, workflowStepThreadKey } from "./engine-deps.js";
import { isWorkflowRunConversation, workflowRunIdFromThreadKey, workflowStepFromThreadKey } from "./run-conversations.js";

it("classifies only run-owned keys and session runtimes", () => {
  expect(workflowRunIdFromThreadKey("signal:workflow:run_1")).toBe("run_1");
  expect(workflowRunIdFromThreadKey("slack-events:C123:workflow:run_1")).toBe("run_1");
  expect(isWorkflowRunConversation("wf:run_1:ask:1", "web:default")).toBe(true);
  // Entry 0 of a step carries no suffix, so `:0` and a third part are malformed.
  for (const key of ["web:default", "workflow:wf_1:local-user", "app-assistant:local-user", "slack-events:C123",
    "signal:workflow:run_1:extra:0", "signal:workflow:run_1:extra:1:2"]) {
    expect(isWorkflowRunConversation("assistant:user:local-user", key)).toBe(false);
  }
});

it("reads the run and step from a step's own thread, plain or under a channel", () => {
  for (const channel of [undefined, "C123"]) {
    expect(workflowStepFromThreadKey(workflowRunThreadKey("run_1", channel))).toBeUndefined();
    expect(workflowStepFromThreadKey(workflowStepThreadKey("run_1", "review", 0, channel))).toEqual({ runId: "run_1", nodeId: "review", iteration: 0 });
    expect(workflowStepFromThreadKey(workflowStepThreadKey("run_1", "review", 3, channel))).toEqual({ runId: "run_1", nodeId: "review", iteration: 3 });
    expect(isWorkflowRunConversation("assistant:user:local-user", workflowStepThreadKey("run_1", "review", 3, channel))).toBe(true);
  }
});
