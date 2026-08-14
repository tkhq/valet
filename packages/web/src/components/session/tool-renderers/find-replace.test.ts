import { describe, expect, it } from "vitest";
import { isFindReplaceCallTool } from "./find-replace";
import { pickRenderer } from "./index";

describe("isFindReplaceCallTool", () => {
  it("claims call_tool invocations for docs.find_and_replace", () => {
    expect(
      isFindReplaceCallTool("call_tool", {
        tool_id: "docs.find_and_replace",
        params: { documentId: "d1", findText: "a", replaceText: "b" },
      }),
    ).toBe(true);
  });

  it("ignores other call_tool ids and other tools", () => {
    expect(isFindReplaceCallTool("call_tool", { tool_id: "workflows.run" })).toBe(false);
    expect(isFindReplaceCallTool("call_tool", {})).toBe(false);
    expect(isFindReplaceCallTool("call_tool", undefined)).toBe(false);
    expect(isFindReplaceCallTool("edit", { tool_id: "docs.find_and_replace" })).toBe(false);
  });
});

describe("pickRenderer routing", () => {
  it("routes mem_patch to its dedicated renderer, not the fallback", () => {
    expect(pickRenderer("mem_patch").matches).toBe("mem_patch");
  });

  it("routes docs.find_and_replace call_tool to the find-replace renderer", () => {
    const r = pickRenderer("call_tool", { tool_id: "docs.find_and_replace" });
    expect(r.matches).toBe(isFindReplaceCallTool);
  });
});
