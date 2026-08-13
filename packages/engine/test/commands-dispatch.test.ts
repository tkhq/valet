import { describe, expect, it } from "vitest";
import { buildCommandRegistry } from "../src/commands/registry.js";
import { dispatchCommand } from "../src/commands/dispatch.js";

// Base registry: only built-ins (status, model, etc.)
const reg = buildCommandRegistry({
  skills: [],
  templates: [],
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
  templates: [],
  pluginCommands: [],
  bareSkillNames: false,
});

const fixTemplate = {
  name: "fix",
  description: "Fix something",
  content: "Fix $1 with priority $2",
  origin: "repo" as const,
};

const regWithTemplate = buildCommandRegistry({
  skills: [],
  templates: [fixTemplate],
  pluginCommands: [],
  bareSkillNames: false,
});

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

  it("expands a skill command into a skill block with args appended", () => {
    const o = dispatchCommand("/skill:review src/", regWithSkill);
    expect(o.kind).toBe("expand");
    if (o.kind === "expand") {
      expect(o.text).toContain('<skill name="review"');
      expect(o.text.endsWith("src/")).toBe(true);
    }
  });

  it("expands a template with substitution", () => {
    // template "fix" content: "Fix $1 with priority $2"
    const o = dispatchCommand('/fix auth "P1 high"', regWithTemplate);
    if (o.kind === "expand") expect(o.text).toBe("Fix auth with priority P1 high");
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
