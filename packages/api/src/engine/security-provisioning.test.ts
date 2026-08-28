import { describe, expect, it } from "vitest";
import {
  AUTHORIZED_SCOPE_ENV,
  authorizedScopeEnv,
  egressViolations,
  parseAuthorizedScopeHosts,
  parseConfigToolDecls,
  securityDeclaredMcpPlugins,
} from "./security-provisioning.js";

describe("parseConfigToolDecls (M-P4a)", () => {
  it("parses structured decls and normalizes a bare string", () => {
    const raw = JSON.stringify([
      "gitleaks",
      { id: "nuclei", install: "apt-get install -y nuclei", egress: ["staging.example.com"] },
      { id: "zap", mcp: { url: "http://127.0.0.1:8090", prefix: "mcp__zap__" } },
    ]);
    expect(parseConfigToolDecls(raw)).toEqual([
      { id: "gitleaks" },
      { id: "nuclei", install: "apt-get install -y nuclei", egress: ["staging.example.com"] },
      { id: "zap", mcp: { url: "http://127.0.0.1:8090", prefix: "mcp__zap__" } },
    ]);
  });

  it("yields [] for null or malformed", () => {
    expect(parseConfigToolDecls(null)).toEqual([]);
    expect(parseConfigToolDecls("not json")).toEqual([]);
    expect(parseConfigToolDecls(JSON.stringify({ not: "an array" }))).toEqual([]);
  });
});

describe("parseAuthorizedScopeHosts (M-P4b)", () => {
  it("parses the hosts list", () => {
    expect(parseAuthorizedScopeHosts(JSON.stringify({ hosts: ["a.example.com", "b.example.com"] }))).toEqual([
      "a.example.com",
      "b.example.com",
    ]);
  });

  it("yields [] for null or malformed", () => {
    expect(parseAuthorizedScopeHosts(null)).toEqual([]);
    expect(parseAuthorizedScopeHosts("nope")).toEqual([]);
    expect(parseAuthorizedScopeHosts(JSON.stringify({ hosts: "notalist" }))).toEqual([]);
  });
});

describe("securityDeclaredMcpPlugins (M-P4a)", () => {
  it("builds one ValetPlugin per declared MCP server, keyed by the prefix", () => {
    const plugins = securityDeclaredMcpPlugins([
      { id: "gitleaks" }, // no mcp — contributes nothing
      { id: "zap", mcp: { url: "http://127.0.0.1:8090", prefix: "mcp__zap__" } },
      { id: "nuclei-mcp", mcp: { url: "http://127.0.0.1:8091" } },
    ]);
    expect(plugins).toHaveLength(2);
    // The mcp prefix decoration is stripped for the service name.
    expect(plugins[0].name).toBe("security-tool-zap");
    expect(plugins[0].actions?.[0].service).toBe("zap");
    // No prefix falls back to the tool id.
    expect(plugins[1].name).toBe("security-tool-nuclei-mcp");
    expect(plugins[1].actions?.[0].service).toBe("nuclei-mcp");
  });

  it("returns no plugins when no decl carries an mcp block", () => {
    expect(securityDeclaredMcpPlugins([{ id: "gitleaks" }, { id: "nuclei" }])).toEqual([]);
  });
});

describe("authorizedScopeEnv (M-P4b)", () => {
  it("emits the allowlist env when the scope names hosts", () => {
    expect(authorizedScopeEnv(["a.example.com", "b.example.com"])).toEqual({
      [AUTHORIZED_SCOPE_ENV]: "a.example.com,b.example.com",
    });
  });

  it("emits nothing when the scope is empty", () => {
    expect(authorizedScopeEnv([])).toEqual({});
    expect(authorizedScopeEnv(["  ", ""])).toEqual({});
  });
});

describe("egressViolations (M-P4b)", () => {
  it("flags an egress host outside the authorized scope", () => {
    const decls = [
      { id: "ok", egress: ["api.example.com"] },
      { id: "bad", egress: ["evil.example.org", "staging.example.com"] },
    ];
    const scope = ["example.com", "staging.example.com"];
    expect(egressViolations(decls, scope)).toEqual([{ toolId: "bad", host: "evil.example.org" }]);
  });

  it("returns none when every egress is in scope", () => {
    const decls = [{ id: "nuclei", egress: ["staging.example.com"] }];
    expect(egressViolations(decls, ["staging.example.com"])).toEqual([]);
  });

  it("flags every egress when the scope is empty", () => {
    const decls = [{ id: "nuclei", egress: ["staging.example.com"] }];
    expect(egressViolations(decls, [])).toEqual([{ toolId: "nuclei", host: "staging.example.com" }]);
  });
});
