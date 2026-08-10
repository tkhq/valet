/**
 * Agent Skills frontmatter validation (https://agentskills.io/specification).
 * Table-driven, and it includes every invalid `name` example the spec
 * lists verbatim.
 */
import { describe, it, expect } from "vitest";
import { validateSkillFrontmatter, type SkillSpecViolation } from "../src/index.js";

function fields(violations: SkillSpecViolation[]): string[] {
  return violations.map((v) => v.field);
}

const VALID = { name: "pdf-processing", description: "Extract PDF text. Use when handling PDFs." };

describe("validateSkillFrontmatter: valid input", () => {
  it("accepts the spec's minimal example", () => {
    expect(validateSkillFrontmatter(VALID)).toEqual([]);
  });

  it("accepts every valid name the spec lists", () => {
    for (const name of ["pdf-processing", "data-analysis", "code-review"]) {
      expect(validateSkillFrontmatter({ ...VALID, name })).toEqual([]);
    }
  });

  it("accepts the optional fields the spec defines", () => {
    const violations = validateSkillFrontmatter({
      ...VALID,
      license: "Apache-2.0",
      compatibility: "Requires git, docker, jq, and access to the internet",
      metadata: { author: "example-org", version: "1.0" },
      "allowed-tools": "Bash(git:*) Read",
    });
    expect(violations).toEqual([]);
  });

  it("accepts a name that matches the parent directory", () => {
    expect(validateSkillFrontmatter(VALID, { directoryName: "pdf-processing" })).toEqual([]);
  });
});

describe("validateSkillFrontmatter: name", () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ["missing", undefined, /required/],
    ["empty", "", /required/],
    ["not a string", 42, /required/],
    // The spec's own invalid examples, verbatim.
    ["PDF-Processing", "PDF-Processing", /lowercase/],
    ["-pdf", "-pdf", /hyphen/],
    ["pdf--processing", "pdf--processing", /consecutive/],
    // The remaining charset and shape rules.
    ["trailing hyphen", "pdf-", /hyphen/],
    ["underscore", "pdf_processing", /lowercase/],
    ["space", "pdf processing", /lowercase/],
    ["65 characters", "a".repeat(65), /64/],
  ];

  for (const [label, name, expected] of cases) {
    it(`rejects ${label}`, () => {
      const violations = validateSkillFrontmatter({ ...VALID, name });
      expect(fields(violations)).toContain("name");
      expect(violations.find((v) => v.field === "name")?.message).toMatch(expected);
    });
  }

  it("accepts exactly 64 characters", () => {
    expect(validateSkillFrontmatter({ ...VALID, name: "a".repeat(64) })).toEqual([]);
  });

  it("rejects a name that does not match the parent directory", () => {
    const violations = validateSkillFrontmatter(VALID, { directoryName: "pdf" });
    expect(fields(violations)).toContain("name");
    expect(violations[0]?.message).toContain("pdf");
  });
});

describe("validateSkillFrontmatter: description", () => {
  it("rejects a missing description", () => {
    const violations = validateSkillFrontmatter({ name: "pdf-processing" });
    expect(fields(violations)).toEqual(["description"]);
    expect(violations[0]?.message).toMatch(/required/);
  });

  it("rejects an empty description", () => {
    expect(fields(validateSkillFrontmatter({ ...VALID, description: "   " }))).toEqual([
      "description",
    ]);
  });

  it("rejects a description longer than 1024 characters", () => {
    const violations = validateSkillFrontmatter({ ...VALID, description: "a".repeat(1025) });
    expect(violations[0]?.message).toMatch(/1024/);
  });

  // Length is the one rule a skill can break while staying usable: the text
  // is all there, it is just long. `anthropics/skills` — the reference
  // repository — ships one. An importer that refuses it is more wrong than
  // one that mirrors it and says so, and no author can fix another org's
  // repository. Every other rule means the skill is broken or unfindable.
  it("marks an over-long description advisory, not an error", () => {
    const violations = validateSkillFrontmatter({ ...VALID, description: "a".repeat(1025) });
    expect(violations[0]?.severity).toBe("advisory");
  });

  it("marks a missing description an error", () => {
    const violations = validateSkillFrontmatter({ ...VALID, description: "   " });
    expect(violations[0]?.severity).toBe("error");
  });

  it("marks a block-scalar-only description an error, not advisory", () => {
    const violations = validateSkillFrontmatter({ ...VALID, description: "|-" });
    expect(violations[0]?.severity).toBe("error");
  });

  it("marks a name violation an error", () => {
    const violations = validateSkillFrontmatter({ ...VALID, name: "Has Capitals" });
    expect(violations[0]?.severity).toBe("error");
  });

  it("accepts exactly 1024 characters", () => {
    expect(validateSkillFrontmatter({ ...VALID, description: "a".repeat(1024) })).toEqual([]);
  });

  // A description that is only a block scalar header means the reader kept
  // the indicator and dropped the text under it. The skill would load, and
  // the model would never find it.
  for (const indicator of ["|", "|-", "|+", ">", ">-", ">+", "|2", ">2-"]) {
    it(`rejects a description that is only "${indicator}"`, () => {
      const violations = validateSkillFrontmatter({ ...VALID, description: indicator });
      expect(fields(violations)).toEqual(["description"]);
      expect(violations[0]?.message).toMatch(/block scalar/);
    });
  }

  it("accepts a description that only contains a block scalar character", () => {
    expect(
      validateSkillFrontmatter({ ...VALID, description: "Use > to send output to a file." }),
    ).toEqual([]);
  });
});

describe("validateSkillFrontmatter: optional fields", () => {
  it("rejects a compatibility longer than 500 characters", () => {
    const violations = validateSkillFrontmatter({ ...VALID, compatibility: "a".repeat(501) });
    expect(fields(violations)).toEqual(["compatibility"]);
    expect(violations[0]?.message).toMatch(/500/);
  });

  it("accepts exactly 500 characters of compatibility", () => {
    expect(validateSkillFrontmatter({ ...VALID, compatibility: "a".repeat(500) })).toEqual([]);
  });

  it("rejects a metadata map whose values are not strings", () => {
    const violations = validateSkillFrontmatter({ ...VALID, metadata: { version: 1 } });
    expect(fields(violations)).toEqual(["metadata"]);
  });

  it("rejects a non-string license and a non-string allowed-tools", () => {
    expect(fields(validateSkillFrontmatter({ ...VALID, license: 7 }))).toEqual(["license"]);
    expect(fields(validateSkillFrontmatter({ ...VALID, "allowed-tools": true }))).toEqual([
      "allowed-tools",
    ]);
  });
});

describe("validateSkillFrontmatter: reporting", () => {
  it("reports every violation instead of stopping at the first", () => {
    const violations = validateSkillFrontmatter({ name: "-Bad-", description: "" });
    expect(fields(violations).sort()).toEqual(["description", "name"]);
  });

  it("names a corrective action in every message", () => {
    const violations = validateSkillFrontmatter({ name: "PDF-Processing", description: "" });
    for (const violation of violations) {
      expect(violation.message.length).toBeGreaterThan(0);
      expect(violation.message).toMatch(/\.\s/);
    }
  });
});
