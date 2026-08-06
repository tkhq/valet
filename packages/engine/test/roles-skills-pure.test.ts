import { describe, it, expect } from "vitest";
import { Type } from "typebox";
import {
  loadRoleFromMarkdown,
  loadSkillFromMarkdown,
  parseMarkdownArtifact,
  renderTemplate,
} from "../src/index.js";

describe("parseMarkdownArtifact", () => {
  it("returns body unchanged when there's no frontmatter", () => {
    const r = parseMarkdownArtifact("# Hello\n\nNo frontmatter.");
    expect(r.frontmatter).toEqual({});
    expect(r.body).toBe("# Hello\n\nNo frontmatter.");
  });

  it("parses simple key:value frontmatter", () => {
    const r = parseMarkdownArtifact(`---
name: github
description: GitHub skill
---

# Body
`);
    expect(r.frontmatter).toEqual({ name: "github", description: "GitHub skill" });
    expect(r.body).toBe("# Body\n");
  });

  it("strips matching surrounding quotes", () => {
    const r = parseMarkdownArtifact(`---
name: "quoted name"
description: 'single-quoted'
---
body
`);
    expect(r.frontmatter.name).toBe("quoted name");
    expect(r.frontmatter.description).toBe("single-quoted");
  });

  it("coerces booleans and numbers", () => {
    const r = parseMarkdownArtifact(`---
enabled: true
disabled: false
count: 42
ratio: 1.5
---
x
`);
    expect(r.frontmatter.enabled).toBe(true);
    expect(r.frontmatter.disabled).toBe(false);
    expect(r.frontmatter.count).toBe(42);
    expect(r.frontmatter.ratio).toBe(1.5);
  });

  it("ignores comment and empty lines in frontmatter", () => {
    const r = parseMarkdownArtifact(`---
# this is a comment
name: x

description: y
---
b
`);
    expect(r.frontmatter).toEqual({ name: "x", description: "y" });
  });

  it("parses a one-level nested map, the shape the skill spec's `metadata` uses", () => {
    const r = parseMarkdownArtifact(`---
name: pdf-processing
metadata:
  author: example-org
  version: "1.0"
license: Apache-2.0
---
body
`);
    expect(r.frontmatter.metadata).toEqual({ author: "example-org", version: "1.0" });
    // The key after the nested block is read at the top level again.
    expect(r.frontmatter.license).toBe("Apache-2.0");
    expect(r.frontmatter.name).toBe("pdf-processing");
  });

  it("keeps an empty-valued key as an empty string when nothing is nested under it", () => {
    const r = parseMarkdownArtifact(`---
metadata:
name: x
---
body
`);
    expect(r.frontmatter.metadata).toBe("");
    expect(r.frontmatter.name).toBe("x");
  });

  it("returns content as body when frontmatter is unclosed", () => {
    const r = parseMarkdownArtifact(`---
name: nope
no closing fence here
`);
    expect(r.frontmatter).toEqual({});
    expect(r.body).toContain("name: nope");
  });
});

describe("renderTemplate", () => {
  it("substitutes simple {{name}} placeholders", () => {
    expect(renderTemplate("Hello {{name}}", { name: "world" })).toBe("Hello world");
  });

  it("allows whitespace inside braces", () => {
    expect(renderTemplate("Hello {{ name }}!", { name: "x" })).toBe("Hello x!");
  });

  it("leaves unknown placeholders untouched", () => {
    expect(renderTemplate("a {{missing}} b", { other: 1 })).toBe("a {{missing}} b");
  });

  it("renders null/undefined as empty string", () => {
    expect(renderTemplate("[{{a}}][{{b}}]", { a: undefined, b: null })).toBe("[][]");
  });

  it("does not interpret nested braces", () => {
    expect(renderTemplate("{{x.y}} {{1bad}}", { "x.y": "broken", "1bad": "broken" })).toBe(
      "{{x.y}} {{1bad}}",
    );
  });
});

describe("loadRoleFromMarkdown", () => {
  it("builds a RoleSpec from frontmatter + body", () => {
    const role = loadRoleFromMarkdown(`---
name: reviewer
description: Code reviewer persona
model: claude-haiku-4-5
---

You are a careful code reviewer.
`);
    expect(role).toMatchObject({
      name: "reviewer",
      description: "Code reviewer persona",
      model: "claude-haiku-4-5",
      source: "session",
    });
    expect(role.content.startsWith("You are a careful code reviewer.")).toBe(true);
  });

  it("throws when name is missing and no fallback supplied", () => {
    expect(() => loadRoleFromMarkdown("# no frontmatter")).toThrow(/name is required/);
  });

  it("uses fallback name when frontmatter omits it", () => {
    const r = loadRoleFromMarkdown("# body", "plugin", "fallback");
    expect(r.name).toBe("fallback");
    expect(r.source).toBe("plugin");
  });
});

describe("loadSkillFromMarkdown", () => {
  it("builds a SkillSource and accepts an explicit argsSchema", () => {
    const schema = Type.Object({ topic: Type.String() });
    const skill = loadSkillFromMarkdown(
      `---
name: research
description: Research a topic
---

Research {{topic}} and report back.
`,
      "plugin",
      undefined,
      schema,
    );
    expect(skill).toMatchObject({
      name: "research",
      description: "Research a topic",
      source: "plugin",
      argsSchema: schema,
    });
    expect(skill.content).toContain("Research {{topic}}");
  });

  it("carries the spec's optional fields, with allowed-tools in camelCase", () => {
    const skill = loadSkillFromMarkdown(`---
name: pdf-processing
description: Extract PDF text. Use when handling PDFs.
license: Apache-2.0
compatibility: Requires Python 3.14+ and uv
metadata:
  author: example-org
  version: "1.0"
allowed-tools: Bash(git:*) Read
---
body
`);
    expect(skill.license).toBe("Apache-2.0");
    expect(skill.compatibility).toBe("Requires Python 3.14+ and uv");
    expect(skill.metadata).toEqual({ author: "example-org", version: "1.0" });
    expect(skill.allowedTools).toBe("Bash(git:*) Read");
  });

  it("throws with the corrective action when the name breaks the spec", () => {
    expect(() =>
      loadSkillFromMarkdown(`---
name: PDF-Processing
description: Extract PDF text.
---
body
`),
    ).toThrow(/lowercase/);
  });

  it("throws when the description is missing", () => {
    expect(() =>
      loadSkillFromMarkdown(`---
name: pdf-processing
---
body
`),
    ).toThrow(/description is required/);
  });

  it("throws when the name does not match the directory name", () => {
    expect(() =>
      loadSkillFromMarkdown(
        `---
name: slack
description: Read and post in Slack.
---
body
`,
        "plugin",
        "slack-tools",
      ),
    ).toThrow(/slack-tools/);
  });

  it("uses the directory name when the frontmatter omits name", () => {
    const skill = loadSkillFromMarkdown(
      `---
description: Read and post in Slack.
---
body
`,
      "plugin",
      "slack-tools",
    );
    expect(skill.name).toBe("slack-tools");
  });
});
