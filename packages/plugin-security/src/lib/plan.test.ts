import { describe, expect, it } from "vitest";
import { cellDirSlug, MAX_PLAN_CELLS, parsePlan } from "./plan.js";

const PERSONAS = ["code-review"] as const;

function planOf(cells: string): string {
  return `cells:\n${cells}`;
}

describe("parsePlan", () => {
  it("parses a valid plan with defaults applied", () => {
    const plan = parsePlan(
      planOf(
        [
          "  - ordinal: 1",
          "    persona: code-review",
          "    goal: Map the codebase",
          "  - ordinal: 2",
          "    persona: code-review",
          "    mode: resume",
          "    goal: Sweep authz",
          "    reads: [1]",
          "    paths: ['packages/api/**']",
          "    review: true",
        ].join("\n"),
      ),
      PERSONAS,
    );
    expect(plan.cells).toHaveLength(2);
    expect(plan.cells[0]).toEqual({
      ordinal: 1,
      persona: "code-review",
      mode: "fresh",
      goal: "Map the codebase",
      reads: [],
      paths: undefined,
      review: undefined,
    });
    expect(plan.cells[1]).toEqual({
      ordinal: 2,
      persona: "code-review",
      mode: "resume",
      goal: "Sweep authz",
      reads: [1],
      paths: ["packages/api/**"],
      review: true,
    });
  });

  it("sorts cells by ordinal", () => {
    const plan = parsePlan(
      planOf(
        [
          "  - ordinal: 2",
          "    persona: code-review",
          "    goal: Second",
          "    reads: [1]",
          "  - ordinal: 1",
          "    persona: code-review",
          "    goal: First",
        ].join("\n"),
      ),
      PERSONAS,
    );
    expect(plan.cells.map((c) => c.goal)).toEqual(["First", "Second"]);
  });

  it("rejects unparseable YAML with a corrective message", () => {
    expect(() => parsePlan("cells: [unclosed", PERSONAS)).toThrow(/not valid YAML/);
    expect(() => parsePlan("cells: [unclosed", PERSONAS)).toThrow(/sec_plan_set/);
  });

  it("rejects a plan without a cells list", () => {
    expect(() => parsePlan("foo: bar", PERSONAS)).toThrow(/non-empty "cells" list/);
    expect(() => parsePlan("cells: []", PERSONAS)).toThrow(/non-empty "cells" list/);
    expect(() => parsePlan("- just a list", PERSONAS)).toThrow(/YAML map/);
  });

  it("rejects an unknown persona and names the known ones", () => {
    const err = /unknown persona "pentest".*code-review/;
    expect(() =>
      parsePlan(planOf("  - ordinal: 1\n    persona: pentest\n    goal: Go"), PERSONAS),
    ).toThrow(err);
  });

  it("rejects non-dense ordinals", () => {
    expect(() =>
      parsePlan(
        planOf(
          [
            "  - ordinal: 1",
            "    persona: code-review",
            "    goal: One",
            "  - ordinal: 3",
            "    persona: code-review",
            "    goal: Three",
          ].join("\n"),
        ),
        PERSONAS,
      ),
    ).toThrow(/dense 1\.\.2.*expected ordinal 2 but found 3/);
    expect(() =>
      parsePlan(planOf("  - ordinal: 2\n    persona: code-review\n    goal: Two"), PERSONAS),
    ).toThrow(/expected ordinal 1 but found 2/);
  });

  it("rejects reads that reference self or later ordinals", () => {
    const cells = [
      "  - ordinal: 1",
      "    persona: code-review",
      "    goal: One",
      "    reads: [1]",
      "  - ordinal: 2",
      "    persona: code-review",
      "    goal: Two",
    ].join("\n");
    expect(() => parsePlan(planOf(cells), PERSONAS)).toThrow(
      /Cell 1 reads ordinal 1.*earlier ordinals only/,
    );

    const later = [
      "  - ordinal: 1",
      "    persona: code-review",
      "    goal: One",
      "    reads: [2]",
      "  - ordinal: 2",
      "    persona: code-review",
      "    goal: Two",
    ].join("\n");
    expect(() => parsePlan(planOf(later), PERSONAS)).toThrow(
      /Cell 1 reads ordinal 2.*earlier ordinals only/,
    );
  });

  it("rejects reads that reference unknown ordinals", () => {
    const cells = [
      "  - ordinal: 1",
      "    persona: code-review",
      "    goal: One",
      "  - ordinal: 2",
      "    persona: code-review",
      "    goal: Two",
      "    reads: [7]",
    ].join("\n");
    expect(() => parsePlan(planOf(cells), PERSONAS)).toThrow(
      /Cell 2 reads ordinal 7, which is not in the plan/,
    );
  });

  it("rejects more than MAX_PLAN_CELLS cells", () => {
    const cells = Array.from({ length: MAX_PLAN_CELLS + 1 }, (_, i) =>
      [`  - ordinal: ${i + 1}`, "    persona: code-review", `    goal: Cell ${i + 1}`].join("\n"),
    ).join("\n");
    expect(() => parsePlan(planOf(cells), PERSONAS)).toThrow(/33 cells.*maximum is 32/);
  });

  it("rejects a missing or empty goal", () => {
    expect(() =>
      parsePlan(planOf("  - ordinal: 1\n    persona: code-review"), PERSONAS),
    ).toThrow(/non-empty "goal"/);
    expect(() =>
      parsePlan(planOf("  - ordinal: 1\n    persona: code-review\n    goal: '  '"), PERSONAS),
    ).toThrow(/non-empty "goal"/);
  });

  it("rejects a non-integer ordinal and a bad mode", () => {
    expect(() =>
      parsePlan(planOf("  - persona: code-review\n    goal: Go"), PERSONAS),
    ).toThrow(/integer "ordinal"/);
    expect(() =>
      parsePlan(
        planOf("  - ordinal: 1\n    persona: code-review\n    mode: warm\n    goal: Go"),
        PERSONAS,
      ),
    ).toThrow(/mode "warm"; use "fresh" or "resume"/);
  });
});

describe("cellDirSlug", () => {
  it("slugifies the documented example", () => {
    expect(cellDirSlug(1, "Map the codebase & seed checklist")).toBe(
      "01-map-the-codebase-seed-checklist",
    );
  });

  it("pads the ordinal to 2 digits", () => {
    expect(cellDirSlug(7, "verify")).toBe("07-verify");
    expect(cellDirSlug(12, "verify")).toBe("12-verify");
  });

  it("strips unicode and collapses repeats", () => {
    expect(cellDirSlug(2, "Authz — sweep ✨ (routes)")).toBe("02-authz-sweep-routes");
    expect(cellDirSlug(3, "  --lots---of--hyphens--  ")).toBe("03-lots-of-hyphens");
  });

  it("truncates to 40 slug characters without a trailing hyphen", () => {
    const goal = "a".repeat(35) + " and then some more words";
    const slug = cellDirSlug(4, goal);
    expect(slug.startsWith("04-")).toBe(true);
    expect(slug.length).toBeLessThanOrEqual(3 + 40);
    expect(slug.endsWith("-")).toBe(false);
    // 35 a's + hyphen + "and" is 39; the next hyphen at 40 is trimmed.
    expect(slug).toBe(`04-${"a".repeat(35)}-and`);
  });
});
