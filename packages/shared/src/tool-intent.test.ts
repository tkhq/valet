import { describe, expect, it } from "vitest";
import { INTENT_EXEMPT_TOOLS, stripToolIntent, withToolIntentSchema } from "./tool-intent.js";

describe("tool intent contract", () => {
  it("pins the exemption list", () => {
    expect(INTENT_EXEMPT_TOOLS).toEqual(["bash", "shell", "read", "write", "edit", "read_file", "write_file", "edit_file", "list_files", "search_files"]);
    for (const name of INTENT_EXEMPT_TOOLS) {
      const schema = { properties: { path: { type: "string" } }, required: ["path"] };
      expect(withToolIntentSchema(name, schema)).toBe(schema);
    }
  });
  it.each([undefined, null, 123, "", "   ", "x".repeat(501)])("rejects invalid intent %s", intent => {
    expect(() => stripToolIntent("task", { intent })).toThrow("Add intent");
  });
  it("trims and caps the only free text", () => {
    expect(stripToolIntent("task", { intent: "  Delegate the tests to check the change.  ", prompt: "brief" })).toEqual({ intent: "Delegate the tests to check the change.", args: { prompt: "brief" } });
    expect(stripToolIntent("task", { intent: "x".repeat(500) }).intent).toHaveLength(500);
  });
});
