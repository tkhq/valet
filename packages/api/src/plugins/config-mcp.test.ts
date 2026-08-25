import { describe, expect, it } from "vitest";
import type { McpServerDecl } from "../config/instance-config.js";
import { InstanceConfigError } from "../config/instance-config.js";
import { CONFIG_MCP_PLUGIN_PREFIX, configMcpPlugins } from "./config-mcp.js";
import { assemblePlugins } from "./assemble.js";

const URL = "https://mcp.example.test/mcp";

function decl(overrides: Partial<McpServerDecl>): McpServerDecl {
  return { name: "example", url: URL, auth: "none", ...overrides };
}

describe("configMcpPlugins", () => {
  it("returns [] for an absent or empty list", () => {
    expect(configMcpPlugins(undefined, {})).toEqual([]);
    expect(configMcpPlugins([], {})).toEqual([]);
  });

  it("skips entries with enabled: false", () => {
    const plugins = configMcpPlugins([decl({ enabled: false })], {});
    expect(plugins).toEqual([]);
  });

  it("builds a prefixed plugin whose action service is the entry name", () => {
    const [plugin] = configMcpPlugins([decl({})], {});
    expect(plugin.name).toBe(`${CONFIG_MCP_PLUGIN_PREFIX}example`);
    expect(plugin.actions?.[0]?.service).toBe("example");
    expect(plugin.actions?.[0]?.resolveActions).toBeDefined();
    // auth: none → no connect flow, tools visible while unconnected.
    expect(plugin.actions?.[0]?.requiresCredential).toBe(false);
    expect(plugin.credentials).toBeUndefined();
  });

  it("oauth entries declare an mcp-mode oauth2 credential against the server url", () => {
    const [plugin] = configMcpPlugins([decl({ auth: "oauth" })], {});
    expect(plugin.credentials).toEqual([
      {
        service: "example",
        type: "oauth2",
        configKeys: ["accessToken"],
        oauth: { mode: "mcp", serverUrl: URL },
      },
    ]);
    expect(plugin.actions?.[0]?.requiresCredential).toBe(true);
  });

  it("oauth entries carry declared scopes onto the credential declaration", () => {
    const scopes = ["agent:query", "agent:search"];
    const [plugin] = configMcpPlugins([decl({ auth: "oauth", scopes })], {});
    expect(plugin.credentials).toEqual([
      {
        service: "example",
        type: "oauth2",
        scopes,
        configKeys: ["accessToken"],
        oauth: { mode: "mcp", serverUrl: URL },
      },
    ]);
  });

  it("api_key entries declare a manual credential with the label defaulted from the name", () => {
    const [labeled] = configMcpPlugins(
      [decl({ auth: "api_key", connectLabel: "Example key" })],
      {},
    );
    expect(labeled.credentials?.[0]?.connectLabel).toBe("Example key");
    const [defaulted] = configMcpPlugins([decl({ auth: "api_key" })], {});
    expect(defaulted.credentials?.[0]).toEqual({
      service: "example",
      type: "api_key",
      configKeys: ["accessToken"],
      connectLabel: "Example API key",
    });
    expect(defaulted.actions?.[0]?.requiresCredential).toBe(true);
  });

  it("carries the entry's displayName onto the plugin and the default connect label", () => {
    const [plugin] = configMcpPlugins(
      [decl({ auth: "api_key", displayName: "Example Cloud" })],
      {},
    );
    expect(plugin.displayName).toBe("Example Cloud");
    expect(plugin.credentials?.[0]?.connectLabel).toBe("Example Cloud API key");
  });

  it("defaults displayName to the title-cased entry name", () => {
    const [plugin] = configMcpPlugins([decl({ name: "grafana-cloud" })], {});
    expect(plugin.displayName).toBe("Grafana Cloud");
  });

  it("bearer entries read the token from env and need no per-user credential", () => {
    const [plugin] = configMcpPlugins(
      [decl({ auth: "bearer", tokenEnv: "EXAMPLE_MCP_TOKEN" })],
      { EXAMPLE_MCP_TOKEN: "tok-123" },
    );
    expect(plugin.credentials).toBeUndefined();
    expect(plugin.actions?.[0]?.requiresCredential).toBe(false);
  });

  it("bearer entries fail boot with the env var named when it is unset or blank", () => {
    const entry = decl({ auth: "bearer", tokenEnv: "EXAMPLE_MCP_TOKEN" });
    for (const env of [{}, { EXAMPLE_MCP_TOKEN: "  " }]) {
      expect(() => configMcpPlugins([entry], env)).toThrow(InstanceConfigError);
      expect(() => configMcpPlugins([entry], env)).toThrow(
        'mcpServers "example": env var EXAMPLE_MCP_TOKEN is not set. Set it, or remove the entry.',
      );
    }
  });

  it("a bearer decl built without tokenEnv (bypassing validation) names the missing field", () => {
    const entry = decl({ auth: "bearer" });
    expect(() => configMcpPlugins([entry], { EXAMPLE_MCP_TOKEN: "tok" })).toThrow(
      'mcpServers "example": auth is "bearer" but tokenEnv is missing. Set tokenEnv to the env var that holds the token.',
    );
  });

  it("a service collision with another plugin throws in assemblePlugins, naming both", () => {
    const bundled = [
      { name: "linear", version: "0.1.0", actions: [{ service: "linear", actions: [] }] },
    ];
    const config = configMcpPlugins([decl({ name: "linear" })], {});
    expect(() => assemblePlugins([bundled, config])).toThrow(
      'plugin service collision: "linear" is claimed by both "linear" and "mcp-config:linear"',
    );
  });
});
