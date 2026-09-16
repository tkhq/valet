import { describe, expect, it } from "vitest";
import { compactConditionLabel, edgeAccessibleLabel, edgeLabelText } from "./flow-edge";

describe("workflow edge labels", () => {
  it("shows the branch meaning with a compact condition", () => {
    expect(edgeLabelText({ fromOutput: "false", when: "nodes.review.result.approved" })).toBe(
      "False · nodes.review.result.approved",
    );
  });

  it("shortens long conditions without losing the accessible full condition", () => {
    const condition = "nodes.review.result.approved && trigger.input.customer.account.isActive";
    expect(compactConditionLabel(condition)).toMatch(/…$/);
    expect(edgeAccessibleLabel({ when: condition })).toBe(`Condition: ${condition}`);
  });

  it("retains branch semantics when no condition is set", () => {
    expect(edgeLabelText({ fromOutput: "true" })).toBe("True");
    expect(edgeAccessibleLabel({ fromOutput: "true" })).toBe("True branch");
  });
});
