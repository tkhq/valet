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

/**
 * Real `SKILL.md` files write long descriptions as YAML block scalars. The
 * description is the field the model reads to decide whether a skill is
 * relevant, so a parser that keeps the `|-` indicator and drops the text
 * makes the skill undiscoverable.
 */
describe("parseMarkdownArtifact: block scalars", () => {
  // The frontmatter of `skills/claude-api/SKILL.md` in anthropics/skills,
  // the file that exposed the bug.
  const CLAUDE_API = `---
name: claude-api
description: |-
  Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use...
  TRIGGER — read BEFORE opening the target file; ...
  SKIP only when another provider is being worked on ...
license: Complete terms in LICENSE.txt
---

# Claude API
`;

  it("reads a real skill's multi-line description instead of the indicator", () => {
    const r = parseMarkdownArtifact(CLAUDE_API);
    expect(r.frontmatter.description).toBe(
      "Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use...\n" +
        "TRIGGER — read BEFORE opening the target file; ...\n" +
        "SKIP only when another provider is being worked on ...",
    );
  });

  it("reads the key that follows the block at the parent indentation", () => {
    const r = parseMarkdownArtifact(CLAUDE_API);
    expect(r.frontmatter.name).toBe("claude-api");
    expect(r.frontmatter.license).toBe("Complete terms in LICENSE.txt");
    expect(r.body).toBe("# Claude API\n");
  });

  it("keeps the line breaks of a literal block, and clips to one trailing newline", () => {
    const r = parseMarkdownArtifact(`---
text: |
  first
  second
next: after
---
b
`);
    expect(r.frontmatter.text).toBe("first\nsecond\n");
    expect(r.frontmatter.next).toBe("after");
  });

  it("joins the lines of a folded block with spaces", () => {
    const r = parseMarkdownArtifact(`---
text: >
  first
  second
next: after
---
b
`);
    expect(r.frontmatter.text).toBe("first second\n");
    expect(r.frontmatter.next).toBe("after");
  });

  it("folds a blank line inside a folded block into a line break", () => {
    const r = parseMarkdownArtifact(`---
text: >-
  first
  still first

  second
---
b
`);
    expect(r.frontmatter.text).toBe("first still first\nsecond");
  });

  it("keeps the blank line inside a literal block", () => {
    const r = parseMarkdownArtifact(`---
text: |-
  first

  second
---
b
`);
    expect(r.frontmatter.text).toBe("first\n\nsecond");
  });

  it("applies the chomping indicator to the trailing newline only", () => {
    const block = (indicator: string) => `---
text: ${indicator}
  first
  second

next: after
---
b
`;
    // strip: no trailing newline. clip: exactly one. keep: one per trailing line.
    expect(parseMarkdownArtifact(block("|-")).frontmatter.text).toBe("first\nsecond");
    expect(parseMarkdownArtifact(block("|")).frontmatter.text).toBe("first\nsecond\n");
    expect(parseMarkdownArtifact(block("|+")).frontmatter.text).toBe("first\nsecond\n\n");
    // Chomping never changes how the interior lines join.
    expect(parseMarkdownArtifact(block(">-")).frontmatter.text).toBe("first second");
    expect(parseMarkdownArtifact(block(">")).frontmatter.text).toBe("first second\n");
    expect(parseMarkdownArtifact(block(">+")).frontmatter.text).toBe("first second\n\n");
    for (const indicator of ["|-", "|", "|+", ">-", ">", ">+"]) {
      expect(parseMarkdownArtifact(block(indicator)).frontmatter.next).toBe("after");
    }
  });

  it("dedents by the block's own indentation, not a fixed two spaces", () => {
    const r = parseMarkdownArtifact(`---
text: |-
      first
        deeper
      last
---
b
`);
    expect(r.frontmatter.text).toBe("first\n  deeper\nlast");
  });

  it("reads an empty block as an empty string", () => {
    const r = parseMarkdownArtifact(`---
text: |-
next: after
other: >
---
b
`);
    expect(r.frontmatter.text).toBe("");
    expect(r.frontmatter.next).toBe("after");
    expect(r.frontmatter.other).toBe("");
  });

  it("drops the carriage return of a file written on Windows", () => {
    const r = parseMarkdownArtifact(
      "---\r\ndescription: |-\r\n  first\r\n  second\r\nlicense: MIT\r\n---\r\nb\r\n",
    );
    expect(r.frontmatter.description).toBe("first\nsecond");
    expect(r.frontmatter.license).toBe("MIT");
  });

  it("reads a block scalar nested in a one-level map", () => {
    const r = parseMarkdownArtifact(`---
metadata:
  author: example-org
  notes: |-
    first
    second
  version: "1.0"
license: Apache-2.0
---
b
`);
    expect(r.frontmatter.metadata).toEqual({
      author: "example-org",
      notes: "first\nsecond",
      version: "1.0",
    });
    expect(r.frontmatter.license).toBe("Apache-2.0");
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

  it("carries a block scalar description through to the SkillSource", () => {
    const skill = loadSkillFromMarkdown(
      `---
name: claude-api
description: |-
  Reference for the Claude API — model ids, pricing, params.
  TRIGGER — read before you open the target file.
license: Complete terms in LICENSE.txt
---
body
`,
      "plugin",
      "claude-api",
    );
    expect(skill.description).toBe(
      "Reference for the Claude API — model ids, pricing, params.\n" +
        "TRIGGER — read before you open the target file.",
    );
    expect(skill.license).toBe("Complete terms in LICENSE.txt");
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
