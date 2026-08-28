import { describe, expect, it } from "vitest";
import { configToPlanYaml, parseSecurityConfig } from "./config.js";
import { BUNDLED_PERSONAS, bundledPersonaIds } from "./personas.js";
import { parsePlan } from "./plan.js";
import { KNOWN_PERSONAS } from "./presets.js";

const KNOWN = bundledPersonaIds();

const VALID = `version: 1
focus: Check the auth boundary
invariants:
  - tenant id is always checked in the repository layer
  - all admin routes sit behind requireAdmin
categories:
  - authz
  - multi-tenancy
tools:
  - gitleaks
steps:
  - ordinal: 1
    persona: code-review
    mode: fresh
    name: recon
    playbook: recon
    goal: Map the codebase and seed the checklist
    reads: []
  - ordinal: 2
    persona: code-review
    mode: fresh
    name: authz
    playbook: authz
    goal: Sweep authorization on every route from the recon map
    reads: [1]
`;

describe("parseSecurityConfig", () => {
  it("parses a valid config with steps, focus, invariants, categories, tools", () => {
    const config = parseSecurityConfig(VALID, KNOWN);
    expect(config.version).toBe(1);
    expect(config.focus).toBe("Check the auth boundary");
    expect(config.invariants).toEqual([
      "tenant id is always checked in the repository layer",
      "all admin routes sit behind requireAdmin",
    ]);
    expect(config.categories).toEqual(["authz", "multi-tenancy"]);
    expect(config.tools).toEqual(["gitleaks"]);
    expect(config.steps).toHaveLength(2);
    expect(config.steps?.map((c) => c.ordinal)).toEqual([1, 2]);
    expect(config.steps?.[0].persona).toBe("code-review");
  });

  it("rejects a version other than 1", () => {
    expect(() => parseSecurityConfig("version: 2\n", KNOWN)).toThrow(/version: 1/);
    expect(() => parseSecurityConfig("focus: x\n", KNOWN)).toThrow(/version: 1/);
  });

  it("rejects a step naming an unknown persona", () => {
    const yaml = `version: 1
steps:
  - ordinal: 1
    persona: ghost
    goal: do something with an unknown persona
    reads: []
`;
    expect(() => parseSecurityConfig(yaml, KNOWN)).toThrow(/unknown persona "ghost"/);
  });

  it("accepts a step naming a config-declared persona", () => {
    const yaml = `version: 1
personas:
  threat-model: .claude/agents/threat-model.md
steps:
  - ordinal: 1
    persona: threat-model
    goal: Build a threat model of the system boundaries
    reads: []
`;
    const config = parseSecurityConfig(yaml, KNOWN);
    expect(config.personas).toEqual({ "threat-model": ".claude/agents/threat-model.md" });
    expect(config.steps?.[0].persona).toBe("threat-model");
  });

  it("rejects a persona map with a non-path value", () => {
    const yaml = `version: 1
personas:
  threat-model: ""
`;
    expect(() => parseSecurityConfig(yaml, KNOWN)).toThrow(/non-empty markdown path/);
  });

  it("rejects non-string invariants/categories/tools", () => {
    expect(() => parseSecurityConfig("version: 1\ninvariants: [1, 2]\n", KNOWN)).toThrow(
      /"invariants" must be a list of strings/,
    );
    expect(() => parseSecurityConfig("version: 1\ncategories: notalist\n", KNOWN)).toThrow(
      /"categories" must be a list of strings/,
    );
    expect(() => parseSecurityConfig("version: 1\ntools: [1]\n", KNOWN)).toThrow(
      /"tools" must be a list of strings/,
    );
  });

  it("rejects malformed YAML with a corrective message", () => {
    expect(() => parseSecurityConfig("version: 1\n  bad: : :\n", KNOWN)).toThrow(
      /Fix .valet\/security.yml/,
    );
  });
});

describe("configToPlanYaml", () => {
  it("round-trips a config's steps through parsePlan", () => {
    const config = parseSecurityConfig(VALID, KNOWN);
    const planYaml = configToPlanYaml(config);
    const plan = parsePlan(planYaml, KNOWN_PERSONAS);
    expect(plan.cells).toHaveLength(2);
    expect(plan.cells.map((c) => c.name)).toEqual(["recon", "authz"]);
    expect(plan.cells[1].reads).toEqual([1]);
    expect(plan.cells[1].playbook).toBe("authz");
  });

  it("throws when the config declares no steps", () => {
    const config = parseSecurityConfig("version: 1\nfocus: x\n", KNOWN);
    expect(() => configToPlanYaml(config)).toThrow(/declares no steps/);
  });
});

describe("BUNDLED_PERSONAS", () => {
  it("includes code-review with a role markdown", () => {
    const ids = BUNDLED_PERSONAS.map((p) => p.id);
    expect(ids).toContain("code-review");
    const codeReview = BUNDLED_PERSONAS.find((p) => p.id === "code-review");
    expect(codeReview?.label).toBe("Code review");
    expect(codeReview?.roleMarkdown).toContain("security code reviewer");
    expect(bundledPersonaIds()).toEqual(["code-review"]);
  });
});
