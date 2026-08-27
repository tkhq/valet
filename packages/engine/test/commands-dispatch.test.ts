import { describe, expect, it } from "vitest";
import { buildSkillBlock } from "@valet/shared";
import { buildCommandRegistry } from "../src/commands/registry.js";
import { dispatchCommand } from "../src/commands/dispatch.js";

// Base registry: only built-ins (status, model, etc.)
const reg = buildCommandRegistry({
  skills: [],
  pluginCommands: [],
  bareSkillNames: false,
});

const reviewSkill = {
  name: "review",
  description: "Review code",
  content: "# Review\nDo a thorough review.",
};

const regWithSkill = buildCommandRegistry({
  skills: [reviewSkill],
  pluginCommands: [],
  bareSkillNames: false,
});

const promptSkill = {
  name: "standup",
  description: "Daily standup",
  content: "Summarize $1 today. Audience: $2.",
  invocation: "prompt" as const,
  argHint: "<topic> [audience]",
};

describe("dispatchCommand", () => {
  it("passes plain text through", () =>
    expect(dispatchCommand("hello", reg).kind).toBe("pass"));

  it("passes unknown /word with a nearMiss", () => {
    const o = dispatchCommand("/statsu", reg);
    expect(o).toEqual({ kind: "pass", nearMiss: "status" });
  });

  it("routes built-ins to execute with parsed args", () => {
    const o = dispatchCommand("/model claude-opus-4-8", reg);
    expect(o.kind).toBe("execute");
    if (o.kind === "execute") expect(o.args).toEqual(["claude-opus-4-8"]);
  });

  it("context-invocation skills keep the <skill> wrap (default)", () => {
    const o = dispatchCommand("/skill:review src/", regWithSkill);
    expect(o.kind).toBe("expand");
    if (o.kind === "expand") {
      expect(o.text).toContain('<skill name="review">');
      expect(o.text.endsWith("src/")).toBe(true);
      // The expansion is EXACTLY the shared builder's output — the web
      // client recovers it with the shared parser, so any format change
      // must land in @valet/shared where both sides see it.
      expect(o.text).toBe(buildSkillBlock("review", reviewSkill.content, "src/"));
      // The skill stamp lets callers put the invocation on the submission's
      // metadata so clients render a card without re-parsing the text.
      expect(o.skill).toEqual({ name: "review", args: "src/" });
    }
  });

  it("prompt-invocation skills substitute args and expand bare", () => {
    const promptReg = buildCommandRegistry({
      skills: [promptSkill],
      pluginCommands: [],
      bareSkillNames: false,
    });
    const o = dispatchCommand('/skill:standup auth "the team"', promptReg);
    expect(o.kind).toBe("expand");
    if (o.kind === "expand") {
      expect(o.text).toBe("Summarize auth today. Audience: the team.");
      expect(o.text).not.toContain("<skill");
      // Prompt skills expand to the user's own message — never stamped,
      // never rendered as a card.
      expect(o.skill).toBeUndefined();
    }
  });

  it("multi-line text starting with / only matches on the first line's first token", () =>
    expect(dispatchCommand("/status\nand more", reg).kind).toBe("execute"));

  it("passes completely unknown /word with no nearMiss", () => {
    const o = dispatchCommand("/zzzzzz", reg);
    expect(o.kind).toBe("pass");
    if (o.kind === "pass") expect(o.nearMiss).toBeUndefined();
  });

  it("expands skill with no args as bare block", () => {
    const o = dispatchCommand("/skill:review", regWithSkill);
    expect(o.kind).toBe("expand");
    if (o.kind === "expand") {
      expect(o.text).toContain('<skill name="review"');
      expect(o.text).toContain(reviewSkill.content.trim());
      expect(o.text).not.toContain("\n\n");
    }
  });

  it("execute carries raw string", () => {
    const o = dispatchCommand("/model claude-opus-4-8", reg);
    if (o.kind === "execute") expect(o.raw).toBe("claude-opus-4-8");
  });
});
