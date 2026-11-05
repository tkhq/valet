/**
 * `ServiceProbes` — the tool listing `/api/plugins` runs for each connected
 * MCP service, read for the tools themselves (the cached tool schema policy
 * surfaces build on), the tool count, and the connection's health (MCP
 * health probe, docs/specs/2026-07-20-integration-oauth-design.md). The
 * plugins are fakes with a scripted `probe`, so nothing here calls a
 * network.
 */
import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import { InMemoryCredentialStore, type ActionPlugin, type CredentialOwner, type PluginAction } from "@valet/engine";
import type { McpActionPlugin, McpProbeResult } from "@valet/sdk/mcp";
import { ServiceProbes } from "./service-probe.js";

const owner: CredentialOwner = { type: "user", id: "u-1" };

function tool(id: string): PluginAction {
  return {
    id,
    name: id.slice(id.indexOf(".") + 1),
    description: `${id} tool`,
    riskLevel: "medium",
    parameters: Type.Object({}),
    execute: async () => ({ success: true }),
  };
}

/** The three tools every listing fixture below returns. */
const TOOLS: PluginAction[] = [tool("mb.search"), tool("mb.browse_data"), tool("mb.execute_query")];

async function storeWith(accessToken: string | null): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  if (accessToken !== null) await store.save(owner, "mb", { type: "oauth2", accessToken, scopes: ["agent:query:run"] });
  return store;
}

/** A fake MCP plugin whose probe answers `next()` and counts its calls. */
function mcpPlugin(next: () => Promise<McpProbeResult>): McpActionPlugin & { calls: number } {
  const plugin = {
    service: "mb",
    actions: [],
    calls: 0,
    resolveActions: async () => [],
    probe: async () => {
      plugin.calls += 1;
      return next();
    },
  };
  return plugin;
}

const listed = (missingScopes: string[] = [], blockedTools = 0): McpProbeResult => ({
  kind: "listed",
  actions: TOOLS,
  missingScopes,
  blockedTools,
});

describe("ServiceProbes result", () => {
  it("reports the listed tools and no health fields for a clean listing", async () => {
    const probes = new ServiceProbes({ credentials: await storeWith("t-1") });
    expect(await probes.get(owner, "mb", mcpPlugin(async () => listed()))).toEqual({ actions: TOOLS });
  });

  it("names the missing scopes and the blocked tool count from a listing", async () => {
    const probes = new ServiceProbes({ credentials: await storeWith("t-1") });
    const result = await probes.get(owner, "mb", mcpPlugin(async () => listed(["agent:content:read"], 2)));
    expect(result).toEqual({ actions: TOOLS, health: { missingScopes: ["agent:content:read"], blockedTools: 2 } });
  });

  it("reports a rejected connection with no tools", async () => {
    const probes = new ServiceProbes({ credentials: await storeWith("t-1") });
    expect(await probes.get(owner, "mb", mcpPlugin(async () => ({ kind: "rejected" })))).toEqual({
      health: { rejected: true },
    });
  });

  it("names the missing scopes from a refused listing", async () => {
    const probes = new ServiceProbes({ credentials: await storeWith("t-1") });
    const result = await probes.get(
      owner,
      "mb",
      mcpPlugin(async () => ({ kind: "insufficient_scope", missingScopes: ["agent:content:read"] })),
    );
    expect(result).toEqual({ health: { missingScopes: ["agent:content:read"] } });
  });

  it("lists a plain dynamic plugin's resolved actions and reports no health", async () => {
    const probes = new ServiceProbes({ credentials: await storeWith("t-1") });
    const plain: ActionPlugin = { service: "mb", actions: [], resolveActions: async () => TOOLS.slice(0, 1) };
    expect(await probes.get(owner, "mb", plain)).toEqual({ actions: TOOLS.slice(0, 1) });
  });

  it("probes nothing when the owner holds no credential for the service", async () => {
    const probes = new ServiceProbes({ credentials: await storeWith(null) });
    const plugin = mcpPlugin(async () => ({ kind: "rejected" }));
    expect(await probes.get(owner, "mb", plugin)).toEqual({});
    expect(plugin.calls).toBe(0);
  });
});

describe("ServiceProbes.listedActionsFor (the cached tool schema policy surfaces read)", () => {
  it("answers the owner's listing, from the cache once `get` has run", async () => {
    const probes = new ServiceProbes({ credentials: await storeWith("t-1") });
    const plugin = mcpPlugin(async () => listed());
    await probes.get(owner, "mb", plugin);
    expect(await probes.listedActionsFor(owner)("mb", plugin)).toEqual(TOOLS);
    expect(plugin.calls).toBe(1);
  });

  it("lists live when nothing is cached", async () => {
    const probes = new ServiceProbes({ credentials: await storeWith("t-1") });
    const plugin = mcpPlugin(async () => listed());
    expect(await probes.listedActionsFor(owner)("mb", plugin)).toEqual(TOOLS);
    expect(plugin.calls).toBe(1);
  });

  it("answers [] for a refused connection, a failed probe, or a missing credential", async () => {
    const refused = new ServiceProbes({ credentials: await storeWith("t-1") });
    expect(await refused.listedActionsFor(owner)("mb", mcpPlugin(async () => ({ kind: "rejected" })))).toEqual([]);

    const failed = new ServiceProbes({ credentials: await storeWith("t-1") });
    const failing = mcpPlugin(async () => {
      throw new Error("MCP mb tools/list failed: HTTP 502");
    });
    expect(await failed.listedActionsFor(owner)("mb", failing)).toEqual([]);

    const disconnected = new ServiceProbes({ credentials: await storeWith(null) });
    expect(await disconnected.listedActionsFor(owner)("mb", mcpPlugin(async () => listed()))).toEqual([]);
  });

  it("snapshot: reads every dynamic plugin ahead, then answers from memory with no further probe or store read", async () => {
    const store = await storeWith("t-1");
    const probes = new ServiceProbes({ credentials: store });
    const plugin = mcpPlugin(async () => listed());
    const plain: ActionPlugin = { service: "other", actions: [tool("other.ping")] };
    const source = await probes.listedActionsSnapshot(owner, [{ actionPlugin: plugin }, { actionPlugin: plain }]);
    expect(plugin.calls).toBe(1);
    // A store that now refuses every read proves the snapshot touches it no more.
    store.get = async () => {
      throw new Error("store read inside the snapshot");
    };
    expect(await source("mb", plugin)).toEqual(TOOLS);
    expect(await source("other", plain)).toEqual([]);
    expect(await source("unknown", plain)).toEqual([]);
    expect(plugin.calls).toBe(1);
  });

  it("answers another owner's listing from that owner's credential, not the cache", async () => {
    const store = await storeWith("t-1");
    const other: CredentialOwner = { type: "user", id: "u-2" };
    const probes = new ServiceProbes({ credentials: store });
    const plugin = mcpPlugin(async () => listed());
    await probes.get(owner, "mb", plugin);
    expect(await probes.listedActionsFor(other)("mb", plugin)).toEqual([]);
    expect(plugin.calls).toBe(1);
  });
});

describe("ServiceProbes limits", () => {
  it("probes once per token within the TTL, and again after a reconnect stores a new token", async () => {
    const store = await storeWith("t-1");
    const probes = new ServiceProbes({ credentials: store });
    const plugin = mcpPlugin(async () => ({ kind: "rejected" }));

    await probes.get(owner, "mb", plugin);
    await probes.get(owner, "mb", plugin);
    expect(plugin.calls).toBe(1);

    await store.save(owner, "mb", { type: "oauth2", accessToken: "t-2" });
    await probes.get(owner, "mb", plugin);
    expect(plugin.calls).toBe(2);
  });

  it("probes again once the TTL passes", async () => {
    let now = 1_000;
    const probes = new ServiceProbes({ credentials: await storeWith("t-1"), now: () => now });
    const plugin = mcpPlugin(async () => listed());
    await probes.get(owner, "mb", plugin);
    now += 5 * 60_000;
    await probes.get(owner, "mb", plugin);
    expect(plugin.calls).toBe(2);
  });

  it("shares one probe between concurrent callers", async () => {
    const probes = new ServiceProbes({ credentials: await storeWith("t-1") });
    const plugin = mcpPlugin(async () => listed());
    await Promise.all([probes.get(owner, "mb", plugin), probes.get(owner, "mb", plugin)]);
    expect(plugin.calls).toBe(1);
  });

  it("reports nothing for a failed probe and caches nothing", async () => {
    const probes = new ServiceProbes({ credentials: await storeWith("t-1") });
    const plugin = mcpPlugin(async () => {
      throw new Error("MCP mb tools/list failed: HTTP 502");
    });
    expect(await probes.get(owner, "mb", plugin)).toEqual({});
    await probes.get(owner, "mb", plugin);
    expect(plugin.calls).toBe(2);
  });

  it("reports nothing for a probe that outlives the timeout and caches nothing", async () => {
    const probes = new ServiceProbes({ credentials: await storeWith("t-1"), timeoutMs: 5 });
    const plugin = mcpPlugin(() => new Promise<McpProbeResult>(() => {}));
    expect(await probes.get(owner, "mb", plugin)).toEqual({});
    await probes.get(owner, "mb", plugin);
    expect(plugin.calls).toBe(2);
  });
});
