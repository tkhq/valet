import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  InstanceConfigError,
  loadInstanceConfig,
  parseInstanceConfig,
  resolveAllowedEmailDomains,
  resolveSsoTeamMapping,
} from "./instance-config.js";

// The illustrative example from the design spec — used verbatim as fixture.
const FULL_YAML = `
version: 1

auth:
  allowedEmailDomains: [turnkey.io]

plugins:
  allow: [plugin-github, plugin-linear]

toolPolicies:
  - action: "github.merge_pull_request"
    mode: deny
  - service: "linear"
    mode: allow
  - riskLevel: critical
    mode: require_approval
    appliesIn: session

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

mcpServers:
  - name: salesforce
    url: https://mcp.salesforce.example/mcp
    auth: oauth
  - name: internal-docs
    url: https://mcp.internal.example/mcp
    auth: bearer
    tokenEnv: INTERNAL_DOCS_MCP_TOKEN
    riskLevel: low
`.trim();

describe("parseInstanceConfig", () => {
  const path = "config/valet.test.yaml";

  it("parses the full illustrative YAML from the spec", () => {
    const cfg = parseInstanceConfig(FULL_YAML, path);
    expect(cfg.version).toBe(1);
    expect(cfg.auth?.allowedEmailDomains).toEqual(["turnkey.io"]);
    expect(cfg.plugins?.allow).toEqual(["plugin-github", "plugin-linear"]);
    expect(cfg.toolPolicies).toHaveLength(3);
    expect(cfg.toolPolicies?.[0]).toEqual({ action: "github.merge_pull_request", mode: "deny" });
    expect(cfg.toolPolicies?.[1]).toEqual({ service: "linear", mode: "allow" });
    expect(cfg.toolPolicies?.[2]).toEqual({
      riskLevel: "critical",
      mode: "require_approval",
      appliesIn: "session",
    });
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
    expect(cfg.mcpServers).toEqual([
      { name: "salesforce", url: "https://mcp.salesforce.example/mcp", auth: "oauth" },
      {
        name: "internal-docs",
        url: "https://mcp.internal.example/mcp",
        auth: "bearer",
        tokenEnv: "INTERNAL_DOCS_MCP_TOKEN",
        riskLevel: "low",
      },
    ]);
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
  - service: "github"
    mode: auto_approve
`.trim();
    expect(() => parseInstanceConfig(yaml, path)).toThrow("toolPolicies[0].mode");
  });

  it("throws when a toolPolicy sets no target dimension", () => {
    const yaml = `
version: 1
toolPolicies:
  - mode: deny
`.trim();
    expect(() => parseInstanceConfig(yaml, path)).toThrow(
      "toolPolicies[0] must set exactly one of service, action, riskLevel",
    );
  });

  it("throws when a toolPolicy sets more than one target dimension", () => {
    const yaml = `
version: 1
toolPolicies:
  - service: "github"
    riskLevel: high
    mode: deny
`.trim();
    expect(() => parseInstanceConfig(yaml, path)).toThrow(
      "toolPolicies[0] sets more than one of service, action, riskLevel",
    );
  });

  it("throws for an unknown toolPolicy riskLevel", () => {
    const yaml = `
version: 1
toolPolicies:
  - riskLevel: extreme
    mode: deny
`.trim();
    expect(() => parseInstanceConfig(yaml, path)).toThrow("toolPolicies[0].riskLevel");
  });

  it("defaults appliesIn to undefined when omitted (reconciler applies \"any\")", () => {
    const cfg = parseInstanceConfig(
      "version: 1\ntoolPolicies:\n  - service: github\n    mode: deny",
      path,
    );
    expect(cfg.toolPolicies?.[0]).toEqual({ service: "github", mode: "deny" });
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
  service: "github"
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

describe("mcpServers validation", () => {
  const path = "config/valet.test.yaml";
  const base = (entry: string) => `version: 1\nmcpServers:\n${entry}`;

  it("accepts every auth mode with its mode-specific keys", () => {
    const yaml = base(
      [
        "  - name: docs",
        "    url: https://mcp.docs.example/mcp",
        "    auth: none",
        "  - name: crm",
        "    url: https://mcp.crm.example/mcp",
        "    auth: oauth",
        "    displayName: Acme CRM",
        "    description: CRM tools",
        "  - name: typefully",
        "    url: https://mcp.typefully.com/mcp",
        "    auth: api_key",
        "    authQueryParam: TYPEFULLY_API_KEY",
        "    connectLabel: Typefully API key",
        "  - name: internal",
        "    url: https://mcp.internal.example/mcp",
        "    auth: bearer",
        "    tokenEnv: INTERNAL_MCP_TOKEN",
        "    enabled: false",
      ].join("\n"),
    );
    const cfg = parseInstanceConfig(yaml, path);
    expect(cfg.mcpServers).toHaveLength(4);
    expect(cfg.mcpServers?.[1]?.displayName).toBe("Acme CRM");
    expect(cfg.mcpServers?.[2]?.authQueryParam).toBe("TYPEFULLY_API_KEY");
    expect(cfg.mcpServers?.[3]?.enabled).toBe(false);
  });

  it("accepts scopes on an oauth entry", () => {
    const yaml = base(
      [
        "  - name: metabase",
        "    url: https://metabase.example/api/metabase-mcp",
        "    auth: oauth",
        "    scopes:",
        "      - agent:query",
        "      - agent:search",
      ].join("\n"),
    );
    const cfg = parseInstanceConfig(yaml, path);
    expect(cfg.mcpServers?.[0]?.scopes).toEqual(["agent:query", "agent:search"]);
  });

  it("rejects scopes on a non-oauth entry", () => {
    const yaml = base(
      "  - name: x\n    url: https://x.example/mcp\n    auth: none\n    scopes: [read]",
    );
    expect(() => parseInstanceConfig(yaml, path)).toThrow(
      'mcpServers[0].scopes is only valid when auth is "oauth". Remove it, or set auth: oauth.',
    );
  });

  it("rejects an empty scopes list as inert", () => {
    const yaml = base("  - name: x\n    url: https://x.example/mcp\n    auth: oauth\n    scopes: []");
    expect(() => parseInstanceConfig(yaml, path)).toThrow(
      "mcpServers[0].scopes must not be empty. List at least one scope, or remove the key.",
    );
  });

  it("rejects a scopes entry that is not a non-empty string", () => {
    const yaml = base(
      '  - name: x\n    url: https://x.example/mcp\n    auth: oauth\n    scopes: ["ok", ""]',
    );
    expect(() => parseInstanceConfig(yaml, path)).toThrow(
      "mcpServers[0].scopes[1] must not be empty",
    );
  });

  it("rejects a scopes entry containing whitespace", () => {
    const yaml = base(
      '  - name: x\n    url: https://x.example/mcp\n    auth: oauth\n    scopes: ["agent:query agent:search"]',
    );
    expect(() => parseInstanceConfig(yaml, path)).toThrow(
      'mcpServers[0].scopes[0] must not contain whitespace, got "agent:query agent:search". Split it into separate list items.',
    );
  });

  it("rejects an empty displayName", () => {
    const yaml = base(
      '  - name: x\n    url: https://x.example/mcp\n    auth: none\n    displayName: ""',
    );
    expect(() => parseInstanceConfig(yaml, path)).toThrow(
      "mcpServers[0].displayName must not be empty",
    );
  });

  it("rejects a name that is not a lowercase slug", () => {
    const yaml = base("  - name: My Server\n    url: https://x.example/mcp\n    auth: none");
    expect(() => parseInstanceConfig(yaml, path)).toThrow("mcpServers[0].name must be a lowercase slug");
  });

  it("rejects a non-http(s) url", () => {
    const yaml = base("  - name: files\n    url: file:///tmp/mcp\n    auth: none");
    expect(() => parseInstanceConfig(yaml, path)).toThrow("mcpServers[0].url must use http or https");
  });

  it("rejects an unknown auth mode", () => {
    const yaml = base("  - name: x\n    url: https://x.example/mcp\n    auth: basic");
    expect(() => parseInstanceConfig(yaml, path)).toThrow(
      'mcpServers[0].auth got "basic", allowed values are none, oauth, api_key, bearer.',
    );
  });

  it("requires tokenEnv for bearer and rejects it elsewhere", () => {
    const missing = base("  - name: x\n    url: https://x.example/mcp\n    auth: bearer");
    expect(() => parseInstanceConfig(missing, path)).toThrow(
      'mcpServers[0].tokenEnv is required when auth is "bearer"',
    );
    const stray = base(
      "  - name: x\n    url: https://x.example/mcp\n    auth: oauth\n    tokenEnv: X_TOKEN",
    );
    expect(() => parseInstanceConfig(stray, path)).toThrow(
      'mcpServers[0].tokenEnv is only valid when auth is "bearer"',
    );
  });

  it("rejects authQueryParam on oauth and connectLabel on bearer", () => {
    const qp = base(
      "  - name: x\n    url: https://x.example/mcp\n    auth: oauth\n    authQueryParam: KEY",
    );
    expect(() => parseInstanceConfig(qp, path)).toThrow(
      'mcpServers[0].authQueryParam is only valid when auth is "api_key" or "bearer"',
    );
    const label = base(
      "  - name: x\n    url: https://x.example/mcp\n    auth: bearer\n    tokenEnv: T\n    connectLabel: X key",
    );
    expect(() => parseInstanceConfig(label, path)).toThrow(
      'mcpServers[0].connectLabel is only valid when auth is "api_key"',
    );
  });

  it("rejects a duplicate name naming both indices", () => {
    const yaml = base(
      [
        "  - name: crm",
        "    url: https://a.example/mcp",
        "    auth: none",
        "  - name: crm",
        "    url: https://b.example/mcp",
        "    auth: none",
      ].join("\n"),
    );
    expect(() => parseInstanceConfig(yaml, path)).toThrow(
      'mcpServers[0] and mcpServers[1] both use the name "crm". Rename one.',
    );
  });

  it("rejects a missing auth with the corrective list", () => {
    const yaml = base("  - name: x\n    url: https://x.example/mcp");
    expect(() => parseInstanceConfig(yaml, path)).toThrow(
      "mcpServers[0].auth is required. Set one of none, oauth, api_key, bearer.",
    );
  });

  it("rejects an unknown key", () => {
    const yaml = base("  - name: x\n    url: https://x.example/mcp\n    auth: none\n    token: abc");
    expect(() => parseInstanceConfig(yaml, path)).toThrow(
      'unknown key "mcpServers[0].token". Remove it or check for a typo.',
    );
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

describe("auth.sso.teams validation", () => {
  const configPath = "config/valet.test.yaml";

  function parse(yaml: string) {
    return parseInstanceConfig(yaml, configPath);
  }

  it("reads the whole mapping", () => {
    const cfg = parse(`
version: 1
auth:
  sso:
    teams:
      claim: groups
      assertedClaim: groups_asserted
      adminSubGroup: admins
      groups:
        - /platform
        - /research
`);
    expect(cfg.auth?.sso?.teams).toEqual({
      claim: "groups",
      assertedClaim: "groups_asserted",
      adminSubGroup: "admins",
      groups: ["/platform", "/research"],
    });
  });

  it("accepts a mapping with no groups allowlist", () => {
    const cfg = parse("version: 1\nauth:\n  sso:\n    teams:\n      adminSubGroup: leads");
    expect(cfg.auth?.sso?.teams).toEqual({ adminSubGroup: "leads" });
  });

  it("rejects the same name for the group claim and the marker claim", () => {
    // The sync tells "in no groups" from "no mapper" by reading one when the
    // other is absent. One name collapses the test.
    expect(() =>
      parse("version: 1\nauth:\n  sso:\n    teams:\n      claim: groups\n      assertedClaim: groups"),
    ).toThrow(/claim and auth\.sso\.teams\.assertedClaim are both "groups"/);
  });

  it("rejects a slash in adminSubGroup", () => {
    expect(() =>
      parse('version: 1\nauth:\n  sso:\n    teams:\n      adminSubGroup: "platform/admins"'),
    ).toThrow(/adminSubGroup must not contain "\/"/);
  });

  it("rejects a group path the sync does not mirror", () => {
    expect(() =>
      parse("version: 1\nauth:\n  sso:\n    teams:\n      groups:\n        - /platform/leads"),
    ).toThrow(/groups\[0\] must be a top-level group path/);
    expect(() =>
      parse("version: 1\nauth:\n  sso:\n    teams:\n      groups:\n        - platform"),
    ).toThrow(/groups\[0\] must be a top-level group path/);
  });

  it("rejects an empty claim name", () => {
    expect(() => parse('version: 1\nauth:\n  sso:\n    teams:\n      claim: "  "')).toThrow(
      /claim must not be empty/,
    );
  });

  it("rejects an unknown key", () => {
    expect(() => parse("version: 1\nauth:\n  sso:\n    teams:\n      claimName: groups")).toThrow(
      /unknown key "auth\.sso\.teams\.claimName"/,
    );
    expect(() => parse("version: 1\nauth:\n  sso:\n    groups: []")).toThrow(
      /unknown key "auth\.sso\.groups"/,
    );
  });

  it("rejects a declared team and a mirrored group that name the same team", () => {
    expect(() =>
      parse(`
version: 1
auth:
  sso:
    teams:
      groups: [/platform]
teams:
  - name: platform
`),
    ).toThrow(/both name team "platform"/);
  });

  it("rejects the same collision when only the case differs", () => {
    // `teams_org_name` is case-sensitive, so these would NOT collide in
    // Postgres — they would make two rows that read as one team in the list.
    // A near-collision nobody can see is worse than one that fails loudly.
    expect(() =>
      parse(`
version: 1
auth:
  sso:
    teams:
      groups: [/platform]
teams:
  - name: Platform
`),
    ).toThrow(/both name team "platform"/);
  });

  it("allows a declared team and a group with different names", () => {
    const cfg = parse(`
version: 1
auth:
  sso:
    teams:
      groups: [/research]
teams:
  - name: platform
`);
    expect(cfg.teams).toEqual([{ name: "platform" }]);
    expect(cfg.auth?.sso?.teams?.groups).toEqual(["/research"]);
  });
});

describe("resolveSsoTeamMapping", () => {
  const configPath = "config/valet.test.yaml";
  const envDefaults = {
    claim: "groups",
    assertedClaim: "groups_asserted",
    adminSubGroup: "admins",
  };

  it("throws per field when env and config both set it", () => {
    const cfg = parseInstanceConfig(
      "version: 1\nauth:\n  sso:\n    teams:\n      adminSubGroup: leads",
      configPath,
    );
    const env: NodeJS.ProcessEnv = { AUTH_OIDC_TEAM_ADMIN_GROUP: "leads", VALET_CONFIG: configPath };
    expect(() => resolveSsoTeamMapping(cfg, env, envDefaults)).toThrow(
      `AUTH_OIDC_TEAM_ADMIN_GROUP is set and ${configPath} declares auth.sso.teams.adminSubGroup. Remove one.`,
    );
  });

  it("guards each of the three fields independently", () => {
    const cfg = parseInstanceConfig(
      "version: 1\nauth:\n  sso:\n    teams:\n      claim: g\n      assertedClaim: ga",
      configPath,
    );
    expect(() =>
      resolveSsoTeamMapping(cfg, { AUTH_OIDC_TEAM_CLAIM: "g", VALET_CONFIG: configPath }, envDefaults),
    ).toThrow(/AUTH_OIDC_TEAM_CLAIM is set/);
    expect(() =>
      resolveSsoTeamMapping(
        cfg,
        { AUTH_OIDC_TEAM_ASSERTED_CLAIM: "ga", VALET_CONFIG: configPath },
        envDefaults,
      ),
    ).toThrow(/AUTH_OIDC_TEAM_ASSERTED_CLAIM is set/);
  });

  it("lets an operator set only the env var the file leaves undeclared", () => {
    // The three are independent, so a per-section guard would reject this
    // legitimate split.
    const cfg = parseInstanceConfig(
      "version: 1\nauth:\n  sso:\n    teams:\n      claim: realm_groups",
      configPath,
    );
    const env: NodeJS.ProcessEnv = { AUTH_OIDC_TEAM_ADMIN_GROUP: "leads", VALET_CONFIG: configPath };
    expect(resolveSsoTeamMapping(cfg, env, { ...envDefaults, adminSubGroup: "leads" })).toEqual({
      claim: "realm_groups",
      assertedClaim: "groups_asserted",
      adminSubGroup: "leads",
    });
  });

  it("returns the env-parsed values when the file declares nothing", () => {
    const cfg = parseInstanceConfig("version: 1", configPath);
    expect(resolveSsoTeamMapping(cfg, {}, envDefaults)).toEqual(envDefaults);
  });

  it("returns the env-parsed values when there is no config file", () => {
    expect(resolveSsoTeamMapping(null, {}, envDefaults)).toEqual(envDefaults);
  });

  it("passes the groups allowlist through, since no env var sets it", () => {
    const cfg = parseInstanceConfig(
      "version: 1\nauth:\n  sso:\n    teams:\n      groups: [/platform]",
      configPath,
    );
    expect(resolveSsoTeamMapping(cfg, {}, envDefaults)).toEqual({
      ...envDefaults,
      groups: ["/platform"],
    });
  });
});
