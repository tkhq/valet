import { describe, expect, it } from "vitest";
import {
  ACTION_RULES,
  CODING_CRAFT_RULES,
  CODING_PERSISTENCE_RULES,
  CODING_SYSTEM_PROMPT,
  MODEL_SWITCH_CORE,
  SECRETS_RULES,
  TOOL_USE_RULES,
  codingSystemPrompt,
  SECRETS_RULES_NO_CLI,
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
    expect(CODING_SYSTEM_PROMPT).toContain("stronger reasoning-model id");
  });

  it("tells a cheap coding session to switch_model before hard work and mid-task", () => {
    expect(flat(CODING_SYSTEM_PROMPT)).toContain(flat(MODEL_SWITCH_CORE));
    expect(CODING_SYSTEM_PROMPT).toContain("call switch_model to a stronger reasoning-model id");
    expect(CODING_SYSTEM_PROMPT).toContain("do not hardcode a vendor family");
    expect(CODING_SYSTEM_PROMPT).toContain("Re-evaluate after you have read the code or a tool result");
    expect(CODING_SYSTEM_PROMPT).toContain("Do not finish a hard task on a cheap model just because you started there");
    expect(CODING_SYSTEM_PROMPT).not.toContain("child_send");
    expect(CODING_SYSTEM_PROMPT).not.toMatch(/Haiku|Sonnet|Opus|Codex/);
  });
  // valet-secrets is installed in every prepped sandbox but appears on no
  // tool list. Without this paragraph the model asks for a pasted credential.
  it("names valet-secrets and the reference shape", () => {
    expect(flat(CODING_SYSTEM_PROMPT)).toContain(flat(SECRETS_RULES));
    expect(CODING_SYSTEM_PROMPT).toContain("valet-secrets run --env NAME=op://vault/item/field");
    expect(CODING_SYSTEM_PROMPT).toContain("Never print a credential");
  });
  // The command is installed by sandbox prep. A build without prep (a
  // workflow session node) must not be told to use it.
  it("composes the secrets paragraph from whether prep installs the CLI", () => {
    const withCli = codingSystemPrompt({ secretsCli: true });
    const without = codingSystemPrompt({ secretsCli: false });
    expect(withCli).toContain("valet-secrets run --env NAME=op://vault/item/field");
    expect(without).not.toContain("valet-secrets run");
    expect(flat(without)).toContain(flat(SECRETS_RULES_NO_CLI));
    expect(without).toContain("Never print a credential");
    expect(CODING_SYSTEM_PROMPT).toBe(withCli);
  });
});
