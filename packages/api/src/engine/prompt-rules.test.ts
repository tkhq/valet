import { describe, expect, it } from "vitest";
import {
  ACTION_RULES,
  CODING_PERSISTENCE_RULES,
  CODING_SYSTEM_PROMPT,
  TOOL_USE_RULES,
} from "./prompt-rules.js";

function flat(text: string): string {
  return text.replace(/\s+/g, " ");
}

describe("coding system prompt (TKAI-239 v1 port)", () => {
  it("keeps the sandbox path and catalog rules", () => {
    const prompt = flat(CODING_SYSTEM_PROMPT);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain(flat(TOOL_USE_RULES));
  });

  it("forbids narrating work without a tool call", () => {
    expect(flat(CODING_SYSTEM_PROMPT)).toContain(flat(ACTION_RULES));
    expect(CODING_SYSTEM_PROMPT).toContain("A turn that does work must contain a tool call");
    expect(CODING_SYSTEM_PROMPT).toContain("A reply with no tool call is a final answer");
  });

  it("defines done as commit, push, and pull request", () => {
    const prompt = flat(CODING_SYSTEM_PROMPT);
    expect(prompt).toContain(flat(CODING_PERSISTENCE_RULES));
    expect(prompt).toContain("Changes are committed to git");
    expect(prompt).toContain("The branch is pushed to the remote");
    expect(prompt).toContain("Do not spawn child sessions");
    expect(prompt).toContain("Treat the spawned branch as the base");
  });
});
