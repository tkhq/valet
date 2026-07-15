/**
 * `GET /api/plugins` — connect-surface manifest read (plugin-system-v2 plan
 * Task 15). Exercises a fixture `ValetPlugin` injected via
 * `bootTestApi({ plugins })` rather than the real bundled registry, so the
 * suite controls exactly which credential declarations / dynamic actions
 * are present.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Type } from "typebox";
import type { PluginAction, ValetPlugin } from "@valet/engine";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { ListPluginsResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

function pingAction(id: string): PluginAction {
  return {
    id,
    name: id,
    description: "test action",
    riskLevel: "low",
    parameters: Type.Object({}),
    execute: async () => ({ success: true, data: {} }),
  };
}

const FIXTURE_PLUGIN: ValetPlugin = {
  name: "fixture-plugin",
  version: "0.1.0",
  description: "A fixture plugin for route tests",
  actions: [
    {
      service: "fixture",
      actions: [pingAction("fixture.ping"), pingAction("fixture.pong")],
      resolveActions: async () => [pingAction("fixture.dynamic")],
    },
  ],
  credentials: [
    {
      service: "fixture",
      type: "api_key",
      configKeys: ["apiKey"],
      connectLabel: "Fixture API key",
    },
  ],
};

/** No `credentials` declarations at all — should list with `services: []`. */
const NO_DECLARATIONS_PLUGIN: ValetPlugin = {
  name: "bare-plugin",
  version: "1.0.0",
  actions: [{ service: "bare", actions: [pingAction("bare.ping")] }],
};

describe("GET /api/plugins", () => {
  it("reflects a fixture plugin's manifest, static action count, and dynamic flag", async () => {
    api = await bootTestApi({ plugins: [FIXTURE_PLUGIN, NO_DECLARATIONS_PLUGIN] });

    const res = await fetch(`${api.baseUrl}/api/plugins`);
    expect(res.status).toBe(200);
    const { plugins } = (await res.json()) as ListPluginsResponse;

    const fixture = plugins.find((p) => p.name === "fixture-plugin");
    expect(fixture).toBeDefined();
    expect(fixture?.version).toBe("0.1.0");
    // Static actions only — the resolveActions-produced "fixture.dynamic" doesn't count.
    expect(fixture?.actionCount).toBe(2);
    expect(fixture?.services).toEqual([
      {
        service: "fixture",
        type: "api_key",
        configKeys: ["apiKey"],
        connectLabel: "Fixture API key",
        connected: false,
        dynamic: true,
      },
    ]);

    // Plugin-level dynamic flag: set on the resolveActions plugin, absent otherwise.
    expect(fixture?.dynamic).toBe(true);

    const bare = plugins.find((p) => p.name === "bare-plugin");
    expect(bare).toBeDefined();
    expect(bare?.services).toEqual([]);
    expect(bare?.actionCount).toBe(1);
    expect(bare?.dynamic).toBeUndefined();
  });

  it("flips connected:true after a credential is saved for the service", async () => {
    api = await bootTestApi({ plugins: [FIXTURE_PLUGIN] });

    await fetch(`${api.baseUrl}/api/credentials/fixture`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api_key", apiKey: "sekret-abc123" }),
    });

    const res = await fetch(`${api.baseUrl}/api/plugins`);
    const { plugins } = (await res.json()) as ListPluginsResponse;
    const fixture = plugins.find((p) => p.name === "fixture-plugin");
    expect(fixture?.services[0]?.connected).toBe(true);

    // Never leaks token material anywhere in the response.
    expect(JSON.stringify(plugins)).not.toContain("sekret-abc123");
  });

  it("only reflects the caller's own connected services", async () => {
    api = await bootTestApi({ plugins: [FIXTURE_PLUGIN] });

    await fetch(`${api.baseUrl}/api/credentials/fixture`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ type: "api_key", apiKey: "member-key" }),
    });

    const res = await fetch(`${api.baseUrl}/api/plugins`);
    const { plugins } = (await res.json()) as ListPluginsResponse;
    const fixture = plugins.find((p) => p.name === "fixture-plugin");
    expect(fixture?.services[0]?.connected).toBe(false);
  });

  it("401s without auth configured", async () => {
    api = await bootTestApi();
    const prev = process.env.VALET_LOCAL_AUTH;
    process.env.VALET_LOCAL_AUTH = "0";
    try {
      const res = await fetch(`${api.baseUrl}/api/plugins`);
      expect(res.status).toBe(401);
    } finally {
      process.env.VALET_LOCAL_AUTH = prev;
    }
  });
});
