import { describe, expect, it } from "vitest";
import {
  ACTION_RULES,
  CODING_CRAFT_RULES,
  CODING_PERSISTENCE_RULES,
  CODING_SYSTEM_PROMPT,
  MODEL_SWITCH_CORE,
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

  it("defines done as a passing check, then commit, push, and pull request", () => {
    const prompt = flat(CODING_SYSTEM_PROMPT);
    expect(prompt).toContain(flat(CODING_PERSISTENCE_RULES));
    expect(prompt).toContain("The named check passed");
    expect(prompt).toContain("Changes are committed to git");
    expect(prompt).toContain("The branch is pushed to the remote");
    expect(prompt).toContain("the command you ran and whether it passed");
    expect(prompt).toContain("Do not spawn child sessions");
    expect(prompt).toContain("Treat the spawned branch as the base");
  });

  it("runs explore, small diff, verify, then switch_model when stuck", () => {
    expect(flat(CODING_SYSTEM_PROMPT)).toContain(flat(CODING_CRAFT_RULES));
    expect(CODING_SYSTEM_PROMPT).toContain("Grep or read before you write");
    expect(CODING_SYSTEM_PROMPT).toContain("Change only what the brief asked");
    expect(CODING_SYSTEM_PROMPT).toContain("A commit is not evidence the change works");
    expect(CODING_SYSTEM_PROMPT).toContain("The same error three times: call switch_model");
  });

  it("tells a cheap coding session to switch_model before hard work and mid-task", () => {
    expect(flat(CODING_SYSTEM_PROMPT)).toContain(flat(MODEL_SWITCH_CORE));
    expect(CODING_SYSTEM_PROMPT).toContain("call switch_model to a Sonnet or Opus id");
    expect(CODING_SYSTEM_PROMPT).toContain("Re-evaluate after you have read the code or a tool result");
    expect(CODING_SYSTEM_PROMPT).toContain("Do not finish a hard task on Haiku just because you started there");
    expect(CODING_SYSTEM_PROMPT).not.toContain("child_send");
  });
});
