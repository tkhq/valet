import { expect, it } from "vitest";
import { isWorkflowRunConversation, workflowRunIdFromThreadKey } from "./run-conversations.js";

it("classifies only run-owned keys and session runtimes", () => {
  expect(workflowRunIdFromThreadKey("signal:workflow:run_1")).toBe("run_1");
  expect(workflowRunIdFromThreadKey("slack-events:C123:workflow:run_1")).toBe("run_1");
  expect(isWorkflowRunConversation("wf:run_1:ask:1", "web:default")).toBe(true);
  for (const key of ["web:default", "workflow:wf_1:local-user", "app-assistant:local-user", "slack-events:C123", "signal:workflow:run_1:extra"]) {
    expect(isWorkflowRunConversation("assistant:user:local-user", key)).toBe(false);
  }
});
