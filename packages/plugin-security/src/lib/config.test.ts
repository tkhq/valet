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
    // A bare-string tool normalizes to a ToolDecl (M-P4a).
    expect(config.tools).toEqual([{ id: "gitleaks" }]);
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

  it("rejects non-string invariants/categories", () => {
    expect(() => parseSecurityConfig("version: 1\ninvariants: [1, 2]\n", KNOWN)).toThrow(
      /"invariants" must be a list of strings/,
    );
    expect(() => parseSecurityConfig("version: 1\ncategories: notalist\n", KNOWN)).toThrow(
      /"categories" must be a list of strings/,
    );
  });

  it("rejects a malformed tool decl (M-P4a)", () => {
    // A number is neither a tool id nor a map.
    expect(() => parseSecurityConfig("version: 1\ntools: [1]\n", KNOWN)).toThrow(
      /tools\[0\] must be a tool id or a map/,
    );
    // A map with no id.
    expect(() =>
      parseSecurityConfig("version: 1\ntools:\n  - install: apt-get install nuclei\n", KNOWN),
    ).toThrow(/tools\[0\] must have a non-empty "id"/);
    // An mcp decl with no url.
    expect(() =>
      parseSecurityConfig("version: 1\ntools:\n  - id: x\n    mcp:\n      prefix: mcp__x__\n", KNOWN),
    ).toThrow(/"mcp.url" must be a non-empty URL/);
  });

  it("parses a structured tool decl with install, mcp, and egress (M-P4a)", () => {
    const yaml = `version: 1
scope:
  hosts:
    - staging.example.com
tools:
  - id: nuclei
    install: apt-get install -y nuclei
    egress:
      - staging.example.com
  - id: zap
    mcp:
      url: http://127.0.0.1:8090
      prefix: mcp__zap__
`;
    const config = parseSecurityConfig(yaml, KNOWN);
    expect(config.scope).toEqual({ hosts: ["staging.example.com"] });
    expect(config.tools).toEqual([
      { id: "nuclei", install: "apt-get install -y nuclei", egress: ["staging.example.com"] },
      { id: "zap", mcp: { url: "http://127.0.0.1:8090", prefix: "mcp__zap__" } },
    ]);
  });

  it("accepts an egress host that is a subdomain of an authorized scope host", () => {
    const yaml = `version: 1
scope:
  hosts:
    - example.com
tools:
  - id: nuclei
    egress:
      - api.example.com
`;
    const config = parseSecurityConfig(yaml, KNOWN);
    expect(config.tools?.[0].egress).toEqual(["api.example.com"]);
  });

  it("rejects a declared egress host outside the authorized scope (M-P4b)", () => {
    const yaml = `version: 1
scope:
  hosts:
    - staging.example.com
tools:
  - id: nuclei
    egress:
      - evil.example.org
`;
    expect(() => parseSecurityConfig(yaml, KNOWN)).toThrow(
      /egress host "evil.example.org" is outside the authorized scope/,
    );
  });

  it("rejects an egress host when no scope is declared (M-P4b)", () => {
    const yaml = `version: 1
tools:
  - id: nuclei
    egress:
      - staging.example.com
`;
    expect(() => parseSecurityConfig(yaml, KNOWN)).toThrow(
      /outside the authorized scope \[\(none declared\)\]/,
    );
  });

  it("rejects a scope with no hosts (M-P4b)", () => {
    expect(() => parseSecurityConfig("version: 1\nscope:\n  hosts: []\n", KNOWN)).toThrow(
      /"scope.hosts" must be a non-empty list/,
    );
    expect(() => parseSecurityConfig("version: 1\nscope: notamap\n", KNOWN)).toThrow(
      /"scope" must be a map with a "hosts" list/,
    );
  });

  it("rejects an unknown threat category with a corrective message", () => {
    expect(() =>
      parseSecurityConfig("version: 1\ncategories:\n  - authz\n  - made-up\n", KNOWN),
    ).toThrow(/unknown threat categor.*"made-up".*Known categories:/s);
  });

  it("accepts a config naming only known categories", () => {
    const config = parseSecurityConfig(
      "version: 1\ncategories:\n  - authz\n  - webhooks\n",
      KNOWN,
    );
    expect(config.categories).toEqual(["authz", "webhooks"]);
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
  });

  it("includes the architect and verifier triad personas (M-P2b)", () => {
    const ids = BUNDLED_PERSONAS.map((p) => p.id);
    // The triad personas sit after code-review; the M-P2c model personas follow,
    // then the M-P3 report persona.
    // The triad personas sit after code-review; the model then live personas follow.
    expect(ids).toEqual([
      "code-review",
      "architect",
      "verifier",
      "threat-model",
      "attack-tree",
      "sast",
      "report",
      "dast",
      "fuzz",
      "exploit",
    ]);
    expect(bundledPersonaIds()).toEqual(ids);

    const architect = BUNDLED_PERSONAS.find((p) => p.id === "architect");
    expect(architect?.label).toBe("Architect");
    // The role markdown is inlined at the call site, so it loaded from disk.
    expect(architect?.roleMarkdown).toContain("You are the ARCHITECT");
    expect(architect?.roleMarkdown).toContain("falsifiable");

    const verifier = BUNDLED_PERSONAS.find((p) => p.id === "verifier");
    expect(verifier?.label).toBe("Verifier");
    expect(verifier?.roleMarkdown).toContain("You are the VERIFIER");
    expect(verifier?.roleMarkdown).toContain("PASS");
  });
});
