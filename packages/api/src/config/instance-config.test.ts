import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InstanceConfigError,
  loadInstanceConfig,
  parseInstanceConfig,
  resolveAllowedEmailDomains,
} from "./instance-config.js";

// The illustrative example from the design spec — used verbatim as fixture.
const FULL_YAML = `
version: 1

auth:
  allowedEmailDomains: [turnkey.io]

plugins:
  allow: [plugin-github, plugin-linear]

toolPolicies:
  - match: "github.merge_pull_request"
    mode: deny
  - match: "linear.*"
    mode: allow
  - match: "*"
    mode: require_approval

org:
  name: Turnkey
  features:
    organizations: true
  modelPreferences:
    - anthropic/claude-opus-4
  bareSkillCommands: true
  members:
    - email: test@valet.test
      role: admin

teams:
  - name: Platform
    members:
      - email: test@valet.test
        role: admin

llmProviders:
  - kind: anthropic
    models:
      - id: claude-opus-4
  - kind: openai_compatible
    name: local-vllm
    baseUrl: http://vllm.internal:8000/v1
    models:
      - id: qwen-coder

skillSources:
  - repo: obra/superpowers
    ref: main
    subpath: skills
`.trim();

describe("parseInstanceConfig", () => {
  const path = "config/valet.test.yaml";

  it("parses the full illustrative YAML from the spec", () => {
    const cfg = parseInstanceConfig(FULL_YAML, path);
    expect(cfg.version).toBe(1);
    expect(cfg.auth?.allowedEmailDomains).toEqual(["turnkey.io"]);
    expect(cfg.plugins?.allow).toEqual(["plugin-github", "plugin-linear"]);
    expect(cfg.toolPolicies).toHaveLength(3);
    expect(cfg.toolPolicies?.[0]).toEqual({ match: "github.merge_pull_request", mode: "deny" });
    expect(cfg.toolPolicies?.[1]).toEqual({ match: "linear.*", mode: "allow" });
    expect(cfg.toolPolicies?.[2]).toEqual({ match: "*", mode: "require_approval" });
    expect(cfg.org?.name).toBe("Turnkey");
    expect(cfg.org?.features).toEqual({ organizations: true });
    expect(cfg.org?.modelPreferences).toEqual(["anthropic/claude-opus-4"]);
    expect(cfg.org?.bareSkillCommands).toBe(true);
    expect(cfg.org?.members).toEqual([{ email: "test@valet.test", role: "admin" }]);
    expect(cfg.teams).toEqual([
      { name: "Platform", members: [{ email: "test@valet.test", role: "admin" }] },
    ]);
    expect(cfg.llmProviders).toHaveLength(2);
    expect(cfg.llmProviders?.[0]).toEqual({ kind: "anthropic", models: [{ id: "claude-opus-4" }] });
    expect(cfg.llmProviders?.[1]).toEqual({
      kind: "openai_compatible",
      name: "local-vllm",
      baseUrl: "http://vllm.internal:8000/v1",
      models: [{ id: "qwen-coder" }],
    });
    expect(cfg.skillSources).toEqual([{ repo: "obra/superpowers", ref: "main", subpath: "skills" }]);
  });

  it("accepts minimal version: 1 file", () => {
    const cfg = parseInstanceConfig("version: 1", path);
    expect(cfg).toEqual({ version: 1 });
  });

  it("throws InstanceConfigError for version 2 with pinned message copy", () => {
    expect(() => parseInstanceConfig("version: 2", path)).toThrow(
      `${path}: version must be 1. Set "version: 1".`,
    );
  });

  it("throws InstanceConfigError for unknown top-level key", () => {
    expect(() => parseInstanceConfig("version: 1\nbogusKey: true", path)).toThrow(
      `${path}: unknown key "bogusKey". Remove it or check for a typo.`,
    );
  });

  it("throws InstanceConfigError for bad toolPolicy mode naming field path", () => {
    const yaml = `
version: 1
toolPolicies:
  - match: "github.*"
    mode: auto_approve
`.trim();
    expect(() => parseInstanceConfig(yaml, path)).toThrow("toolPolicies[0].mode");
  });

  it("throws InstanceConfigError for openai_compatible without name", () => {
    const yaml = `
version: 1
llmProviders:
  - kind: openai_compatible
    baseUrl: http://localhost:8000/v1
`.trim();
    expect(() => parseInstanceConfig(yaml, path)).toThrow(InstanceConfigError);
    expect(() => parseInstanceConfig(yaml, path)).toThrow("name");
  });

  it("normalizes allowedEmailDomains to lowercase trimmed, dropping empties", () => {
    const yaml = `
version: 1
auth:
  allowedEmailDomains: ["  TURNKEY.IO  ", "", "example.com"]
`.trim();
    const cfg = parseInstanceConfig(yaml, path);
    expect(cfg.auth?.allowedEmailDomains).toEqual(["turnkey.io", "example.com"]);
  });

  it("normalizes member emails to lowercase trimmed", () => {
    const yaml = `
version: 1
org:
  members:
    - email: "  ADMIN@VALET.TEST  "
      role: admin
`.trim();
    const cfg = parseInstanceConfig(yaml, path);
    expect(cfg.org?.members?.[0]?.email).toBe("admin@valet.test");
  });

  it("throws when member email has no @", () => {
    const yaml = `
version: 1
org:
  members:
    - email: notanemail
      role: admin
`.trim();
    expect(() => parseInstanceConfig(yaml, path)).toThrow(InstanceConfigError);
  });

  it("throws when member role is invalid", () => {
    const yaml = `
version: 1
org:
  members:
    - email: user@example.com
      role: superuser
`.trim();
    expect(() => parseInstanceConfig(yaml, path)).toThrow("org.members[0].role");
  });

  it("throws when llmProviders kind is invalid", () => {
    const yaml = `
version: 1
llmProviders:
  - kind: bedrock
`.trim();
    expect(() => parseInstanceConfig(yaml, path)).toThrow("llmProviders[0].kind");
  });

  it("throws when toolPolicies is not an array", () => {
    const yaml = `
version: 1
toolPolicies:
  match: "*.foo"
  mode: deny
`.trim();
    expect(() => parseInstanceConfig(yaml, path)).toThrow(InstanceConfigError);
  });

  it("throws when version is missing", () => {
    expect(() => parseInstanceConfig("org:\n  name: Foo", path)).toThrow(InstanceConfigError);
  });

  it("throws when skillSources has duplicate (repo, subpath) entries differing only by ref", () => {
    const yaml = `
version: 1
skillSources:
  - repo: owner/skills
    ref: main
    subpath: skills
  - repo: owner/skills
    ref: v2
    subpath: skills
`.trim();
    expect(() => parseInstanceConfig(yaml, path)).toThrow(
      "skillSources[0] and skillSources[1] track the same repository and subpath. Remove one (a source can track only one ref).",
    );
  });

  it("throws when skillSources has duplicate (repo, subpath) differing by repo case", () => {
    const yaml = `
version: 1
skillSources:
  - repo: Owner/Skills
    ref: main
  - repo: owner/skills
    ref: feature
`.trim();
    expect(() => parseInstanceConfig(yaml, path)).toThrow(
      "skillSources[0] and skillSources[1] track the same repository and subpath. Remove one (a source can track only one ref).",
    );
  });

  it("allows skillSources with same repo but different subpaths", () => {
    const yaml = `
version: 1
skillSources:
  - repo: owner/skills
    ref: main
    subpath: skills
  - repo: owner/skills
    ref: main
    subpath: roles
`.trim();
    const cfg = parseInstanceConfig(yaml, path);
    expect(cfg.skillSources).toHaveLength(2);
  });
});

describe("loadInstanceConfig", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "valet-icfg-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("returns null when VALET_CONFIG is unset", () => {
    const env: NodeJS.ProcessEnv = {};
    expect(loadInstanceConfig(env)).toBeNull();
  });

  it("throws InstanceConfigError with pinned message for a missing file path", () => {
    const missing = join(dir, "nonexistent.yaml");
    const env: NodeJS.ProcessEnv = { VALET_CONFIG: missing };
    expect(() => loadInstanceConfig(env)).toThrow(
      `Config file not found at ${missing}. Fix VALET_CONFIG or create the file.`,
    );
  });

  it("reads a real tmp file and returns the parsed config", () => {
    const cfgPath = join(dir, "valet.yaml");
    writeFileSync(cfgPath, "version: 1\n");
    const env: NodeJS.ProcessEnv = { VALET_CONFIG: cfgPath };
    const cfg = loadInstanceConfig(env);
    expect(cfg).toEqual({ version: 1 });
  });

  it("throws InstanceConfigError for invalid content in the file", () => {
    const cfgPath = join(dir, "valet.yaml");
    writeFileSync(cfgPath, "version: 2\n");
    const env: NodeJS.ProcessEnv = { VALET_CONFIG: cfgPath };
    expect(() => loadInstanceConfig(env)).toThrow(InstanceConfigError);
  });
});

describe("resolveAllowedEmailDomains", () => {
  const configPath = "config/valet.test.yaml";

  it("throws with pinned copy when both env and config declare domains", () => {
    const cfg = parseInstanceConfig(
      "version: 1\nauth:\n  allowedEmailDomains: [example.com]",
      configPath,
    );
    const env: NodeJS.ProcessEnv = {
      AUTH_ALLOWED_EMAIL_DOMAINS: "example.com",
      VALET_CONFIG: configPath,
    };
    const envParsed = ["example.com"];
    expect(() => resolveAllowedEmailDomains(cfg, env, envParsed)).toThrow(
      `AUTH_ALLOWED_EMAIL_DOMAINS is set and ${configPath} declares auth.allowedEmailDomains. Remove one.`,
    );
  });

  it("returns config domains when only config declares them", () => {
    const cfg = parseInstanceConfig(
      "version: 1\nauth:\n  allowedEmailDomains: [turnkey.io]",
      configPath,
    );
    const env: NodeJS.ProcessEnv = { VALET_CONFIG: configPath };
    expect(resolveAllowedEmailDomains(cfg, env, [])).toEqual(["turnkey.io"]);
  });

  it("returns envParsed domains when only env is set", () => {
    const cfg = parseInstanceConfig("version: 1", configPath);
    const env: NodeJS.ProcessEnv = {
      AUTH_ALLOWED_EMAIL_DOMAINS: "example.com",
      VALET_CONFIG: configPath,
    };
    expect(resolveAllowedEmailDomains(cfg, env, ["example.com"])).toEqual(["example.com"]);
  });

  it("returns empty array when neither source declares domains", () => {
    const cfg = parseInstanceConfig("version: 1", configPath);
    const env: NodeJS.ProcessEnv = {};
    expect(resolveAllowedEmailDomains(cfg, env, [])).toEqual([]);
  });

  it("returns envParsed when cfg is null", () => {
    const env: NodeJS.ProcessEnv = {
      AUTH_ALLOWED_EMAIL_DOMAINS: "example.com",
    };
    expect(resolveAllowedEmailDomains(null, env, ["example.com"])).toEqual(["example.com"]);
  });
});
