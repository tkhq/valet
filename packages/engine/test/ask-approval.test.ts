import { expect, it } from "vitest";
import { askApprovalTool } from "../src/builtin-tools/index.js";

// ask_approval opens a plain Approve/Deny question that no policy can answer
// and that offers no "always allow". An integration action gets the
// policy-checked approval from call_tool instead.
it("sends integration actions to call_tool's policy approval", () => {
  expect(askApprovalTool.description).toContain("Do not use it before an integration action");
});
