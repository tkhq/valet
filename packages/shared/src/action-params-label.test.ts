import { describe, expect, it } from "vitest";
import { actionParamsLabel } from "./action-params-label.js";

describe("actionParamsLabel", () => {
  it("names the field that says what the action creates or changes", () => {
    expect(actionParamsLabel({ teamId: "t-1", title: "Fix bug", name: "Onboarding" })).toEqual({ key: "name", value: "Onboarding" });
    expect(actionParamsLabel({ body: "text", title: "Fix bug" })).toEqual({ key: "title", value: "Fix bug" });
  });

  it("collapses whitespace and cuts a long value", () => {
    expect(actionParamsLabel({ name: "  New\n  hire  " })).toEqual({ key: "name", value: "New hire" });
    const label = actionParamsLabel({ subject: "x".repeat(200) });
    expect(label?.value).toHaveLength(80);
    expect(label?.value.endsWith("…")).toBe(true);
  });

  it("returns undefined when no such text field exists", () => {
    for (const params of [undefined, null, "name", ["name"], { id: 1 }, { name: 3 }, { name: "   " }]) {
      expect(actionParamsLabel(params)).toBeUndefined();
    }
  });
});
