import { describe, expect, it } from "vitest";
import { stripToolIntent, withToolIntentSchema } from "./tool-intent.js";
const tool = { parameters: { type: "object", properties: {} } };
describe("tool intent contract", () => {
  it.each([undefined, null, 123, "", "   ", "x".repeat(501)])("rejects invalid intent %s", intent => {
    expect(() => stripToolIntent(tool, { intent })).toThrow("Add intent");
  });
  it("trims and caps metadata", () => {
    expect(stripToolIntent(tool, { intent: "  Delegate the tests to check the change.  ", prompt: "brief" })).toEqual({ intent: "Delegate the tests to check the change.", args: { prompt: "brief" } });
    expect(stripToolIntent(tool, { intent: "x".repeat(500) }).intent).toHaveLength(500);
  });
  it("preserves an action's own intent and non-object schemas", () => {
    const schema = { type: "object", properties: { intent: { type: "number" } } };
    const action = { parameters: schema };
    expect(withToolIntentSchema(action, schema)).toBe(schema);
    expect(stripToolIntent(action, { intent: 42 })).toEqual({ intent: null, args: { intent: 42 } });
    const array = { type: "array" };
    expect(withToolIntentSchema({ parameters: array }, array)).toBe(array);
  });
  it("uses summary without a second free-text argument", () => {
    const broker = { ...tool, intent: "summary" as const };
    expect(withToolIntentSchema(broker, tool.parameters)).toBe(tool.parameters);
    expect(stripToolIntent(broker, { summary: "  Check access. " })).toEqual({ args: { summary: "  Check access. " }, intent: "Check access." });
  });
});
