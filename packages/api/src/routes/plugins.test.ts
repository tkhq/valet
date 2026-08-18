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
        connect: "manual",
        actions: [
          { id: "fixture.ping", name: "fixture.ping", riskLevel: "low", requiresApproval: false },
          { id: "fixture.pong", name: "fixture.pong", riskLevel: "low", requiresApproval: false },
        ],
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

  it("exposes actions:[] for a declared credential service with no matching action plugin", async () => {
    const noActionsPlugin: ValetPlugin = {
      name: "creds-only-plugin",
      version: "1.0.0",
      credentials: [{ service: "credsonly", type: "api_key", configKeys: ["apiKey"] }],
    };
    api = await bootTestApi({ plugins: [noActionsPlugin] });

    const res = await fetch(`${api.baseUrl}/api/plugins`);
    const { plugins } = (await res.json()) as ListPluginsResponse;
    const plugin = plugins.find((p) => p.name === "creds-only-plugin");
    expect(plugin?.services).toEqual([
      {
        service: "credsonly",
        type: "api_key",
        configKeys: ["apiKey"],
        connected: false,
        connect: "manual",
        actions: [],
      },
    ]);
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

describe("GET /api/plugins iconSlug", () => {
  it("carries the bundled manifest's slug, and nothing for a plugin that declares none", async () => {
    // "github" is a real bundled plugin name, so it has an entry in the
    // generated slug map; "fixture-plugin" never will.
    const plugins: ValetPlugin[] = [
      { name: "github", version: "0.1.0", credentials: [{ type: "oauth2", configKeys: ["accessToken"] }] },
      FIXTURE_PLUGIN,
    ];
    api = await bootTestApi({ plugins });

    const res = await fetch(`${api.baseUrl}/api/plugins`);
    const { plugins: summaries } = (await res.json()) as ListPluginsResponse;
    expect(summaries.find((p) => p.name === "github")?.services[0]?.iconSlug).toBe("github");
    expect(summaries.find((p) => p.name === "fixture-plugin")?.services[0]?.iconSlug).toBeUndefined();
  });
});

describe("GET /api/plugins health", () => {
  const OWNER = { type: "user", id: "local-user" } as const;

  it("reports no health while the service is disconnected", async () => {
    api = await bootTestApi({ plugins: [FIXTURE_PLUGIN] });
    const res = await fetch(`${api.baseUrl}/api/plugins`);
    const { plugins } = (await res.json()) as ListPluginsResponse;
    expect(plugins.find((p) => p.name === "fixture-plugin")?.services[0]?.health).toBeUndefined();
  });

  it("reports the account, the expiry, the refresh failure, and the identity-only grant", async () => {
    api = await bootTestApi({ plugins: [FIXTURE_PLUGIN] });
    const expiresAt = Date.now() - 60_000;
    await api.providers.engineCredentials.save(OWNER, "fixture", {
      type: "oauth2",
      accessToken: "stale-token-xyz",
      expiresAt,
      metadata: { login: "someone@example.com", refreshFailedAt: 1_700_000_000_000, identityOnly: true },
    });

    const res = await fetch(`${api.baseUrl}/api/plugins`);
    const { plugins } = (await res.json()) as ListPluginsResponse;
    const service = plugins.find((p) => p.name === "fixture-plugin")?.services[0];
    expect(service?.connected).toBe(true);
    expect(service?.health).toEqual({
      expiresAt,
      login: "someone@example.com",
      refreshFailed: true,
      identityOnly: true,
    });
    // Health never carries token material.
    expect(JSON.stringify(plugins)).not.toContain("stale-token-xyz");
  });

  it("reports an empty health object for a healthy credential with no metadata", async () => {
    api = await bootTestApi({ plugins: [FIXTURE_PLUGIN] });
    await fetch(`${api.baseUrl}/api/credentials/fixture`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api_key", apiKey: "k-1" }),
    });

    const res = await fetch(`${api.baseUrl}/api/plugins`);
    const { plugins } = (await res.json()) as ListPluginsResponse;
    const service = plugins.find((p) => p.name === "fixture-plugin")?.services[0];
    // An API key reports no expiry and no login — "nothing known", which is
    // NOT the same as "expired".
    expect(service?.health).toEqual({});
  });
});

describe("GET /api/plugins connect mode", () => {
  it("reports oauth for mcp-mode declarations and manual otherwise", async () => {
    const plugins: ValetPlugin[] = [
      {
        name: "linear", version: "0.1.0",
        credentials: [{ type: "oauth2", configKeys: ["accessToken"], oauth: { mode: "mcp", serverUrl: "https://mcp.linear.app/mcp" } }],
      },
      { name: "slack", version: "0.1.0", credentials: [{ type: "bot_token", configKeys: ["accessToken"] }] },
    ];
    api = await bootTestApi({ plugins });
    const res = await fetch(`${api.baseUrl}/api/plugins`);
    const { plugins: summaries } = (await res.json()) as ListPluginsResponse;
    const linear = summaries.find((p) => p.name === "linear")?.services[0];
    const slack = summaries.find((p) => p.name === "slack")?.services[0];
    expect(linear?.connect).toBe("oauth");
    expect(slack?.connect).toBe("manual");
  });

  it("reports unconfigured for authorization_code declarations whose env vars are unset", async () => {
    // No manual fallback: a pasted access token cannot refresh without the
    // client secret (integration-availability design).
    const plugins: ValetPlugin[] = [{
      name: "gmail", version: "0.1.0",
      credentials: [{
        type: "oauth2", configKeys: ["accessToken"],
        oauth: {
          mode: "authorization_code",
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          clientIdEnv: "UNSET_TEST_ID", clientSecretEnv: "UNSET_TEST_SECRET",
        },
      }],
    }];
    api = await bootTestApi({ plugins });
    const res = await fetch(`${api.baseUrl}/api/plugins`);
    const { plugins: summaries } = (await res.json()) as ListPluginsResponse;
    expect(summaries.find((p) => p.name === "gmail")?.services[0]?.connect).toBe("unconfigured");
  });

  it("reports unconfigured for a requires.orgCredential service until the org credential exists", async () => {
    const plugins: ValetPlugin[] = [{
      name: "slack", version: "0.1.0",
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    }];
    api = await bootTestApi({ plugins });

    const before = await fetch(`${api.baseUrl}/api/plugins`);
    const beforeBody = (await before.json()) as ListPluginsResponse;
    expect(beforeBody.plugins.find((p) => p.name === "slack")?.services[0]?.connect).toBe("unconfigured");

    await api.providers.engineCredentials.save({ type: "org", id: "local-org" }, "slack", {
      type: "bot_token",
      accessToken: "xoxb-org-token",
    });

    const after = await fetch(`${api.baseUrl}/api/plugins`);
    const afterBody = (await after.json()) as ListPluginsResponse;
    expect(afterBody.plugins.find((p) => p.name === "slack")?.services[0]?.connect).toBe("manual");
  });

  /**
   * The reason behind an unconfigured OAuth service, for the one person who
   * can act on it. `local-user` holds `org_members.role = "admin"` in the
   * harness; `test-member` holds `"member"` and selects itself through the
   * `x-valet-test-user-id` impersonation header.
   */
  describe("missingEnv", () => {
    const googlePlugin: ValetPlugin = {
      name: "gmail",
      version: "0.1.0",
      credentials: [{
        type: "oauth2", configKeys: ["accessToken"],
        oauth: {
          mode: "authorization_code",
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          clientIdEnv: "UNSET_TEST_ID", clientSecretEnv: "UNSET_TEST_SECRET",
        },
      }],
    };

    async function gmailService(headers?: Record<string, string>) {
      if (!api) throw new Error("api not booted");
      const res = await fetch(`${api.baseUrl}/api/plugins`, { headers });
      const { plugins } = (await res.json()) as ListPluginsResponse;
      return plugins.find((p) => p.name === "gmail")?.services[0];
    }

    it("names the unset client variables to an org admin", async () => {
      api = await bootTestApi({ plugins: [googlePlugin] });

      const service = await gmailService();
      expect(service?.connect).toBe("unconfigured");
      expect(service?.missingEnv).toEqual(["UNSET_TEST_ID", "UNSET_TEST_SECRET"]);
    });

    it("omits the key entirely for a plain member", async () => {
      api = await bootTestApi({ plugins: [googlePlugin] });

      const service = await gmailService({ "x-valet-test-user-id": "test-member" });
      // Same availability answer, no reason attached: the member's response
      // carries no variable names at all, so the tile stays hidden.
      expect(service?.connect).toBe("unconfigured");
      expect(service?.missingEnv).toBeUndefined();
    });

    it("names only the unset half of a half-set pair", async () => {
      process.env.UNSET_TEST_ID = "an-id";
      try {
        api = await bootTestApi({ plugins: [googlePlugin] });

        const service = await gmailService();
        expect(service?.connect).toBe("unconfigured");
        expect(service?.missingEnv).toEqual(["UNSET_TEST_SECRET"]);
      } finally {
        delete process.env.UNSET_TEST_ID;
      }
    });

    it("never carries the value behind a set variable", async () => {
      process.env.UNSET_TEST_ID = "google-client-id-value";
      try {
        api = await bootTestApi({ plugins: [googlePlugin] });

        const res = await fetch(`${api.baseUrl}/api/plugins`);
        const body = await res.text();
        expect(body).toContain("UNSET_TEST_SECRET");
        expect(body).not.toContain("google-client-id-value");
      } finally {
        delete process.env.UNSET_TEST_ID;
      }
    });

    it("is absent for a configured service, for an admin too", async () => {
      process.env.UNSET_TEST_ID = "an-id";
      process.env.UNSET_TEST_SECRET = "a-secret";
      try {
        api = await bootTestApi({ plugins: [googlePlugin] });

        const service = await gmailService();
        expect(service?.connect).toBe("oauth");
        expect(service?.missingEnv).toBeUndefined();
      } finally {
        delete process.env.UNSET_TEST_ID;
        delete process.env.UNSET_TEST_SECRET;
      }
    });

    it("is absent for an org-credential prerequisite, whose fix is not a variable", async () => {
      api = await bootTestApi({ plugins: [{
        name: "slack", version: "0.1.0",
        credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
      }] });

      const res = await fetch(`${api.baseUrl}/api/plugins`);
      const { plugins } = (await res.json()) as ListPluginsResponse;
      const slack = plugins.find((p) => p.name === "slack")?.services[0];
      expect(slack?.connect).toBe("unconfigured");
      expect(slack?.missingEnv).toBeUndefined();
    });
  });

  /**
   * The CAUSE, unlike the variable names, goes to every caller: each cause
   * has a different corrective action, and a member who still sees the tile
   * must not read the one that names a page which cannot perform the fix.
   */
  describe("connectBlockedBy", () => {
    const googlePlugin: ValetPlugin = {
      name: "gmail",
      version: "0.1.0",
      credentials: [{
        type: "oauth2", configKeys: ["accessToken"],
        oauth: {
          mode: "authorization_code",
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
          tokenUrl: "https://oauth2.googleapis.com/token",
          clientIdEnv: "UNSET_TEST_ID", clientSecretEnv: "UNSET_TEST_SECRET",
        },
      }],
    };

    async function firstService(name: string, headers?: Record<string, string>) {
      if (!api) throw new Error("api not booted");
      const res = await fetch(`${api.baseUrl}/api/plugins`, { headers });
      const { plugins } = (await res.json()) as ListPluginsResponse;
      return plugins.find((p) => p.name === name)?.services[0];
    }

    it("reports the deployment cause to a member, who gets no variable names", async () => {
      api = await bootTestApi({ plugins: [googlePlugin] });

      const service = await firstService("gmail", { "x-valet-test-user-id": "test-member" });
      expect(service?.connect).toBe("unconfigured");
      expect(service?.connectBlockedBy).toBe("deployment");
      expect(service?.missingEnv).toBeUndefined();
    });

    it("reports the org cause, whose fix is Settings → Organization", async () => {
      api = await bootTestApi({ plugins: [{
        name: "slack", version: "0.1.0",
        credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
      }] });

      const service = await firstService("slack", { "x-valet-test-user-id": "test-member" });
      expect(service?.connect).toBe("unconfigured");
      expect(service?.connectBlockedBy).toBe("org");
    });

    it("is absent for a service anybody can connect", async () => {
      process.env.UNSET_TEST_ID = "an-id";
      process.env.UNSET_TEST_SECRET = "a-secret";
      try {
        api = await bootTestApi({ plugins: [googlePlugin] });

        const service = await firstService("gmail");
        expect(service?.connect).toBe("oauth");
        expect(service?.connectBlockedBy).toBeUndefined();
      } finally {
        delete process.env.UNSET_TEST_ID;
        delete process.env.UNSET_TEST_SECRET;
      }
    });
  });

  it("keeps connected:true on an unconfigured service so a leftover credential stays visible", async () => {
    const plugins: ValetPlugin[] = [{
      name: "slack", version: "0.1.0",
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    }];
    api = await bootTestApi({ plugins });
    await api.providers.engineCredentials.save({ type: "user", id: "local-user" }, "slack", {
      type: "bot_token",
      accessToken: "xoxb-personal",
    });

    const res = await fetch(`${api.baseUrl}/api/plugins`);
    const { plugins: summaries } = (await res.json()) as ListPluginsResponse;
    const slack = summaries.find((p) => p.name === "slack")?.services[0];
    expect(slack?.connected).toBe(true);
    expect(slack?.connect).toBe("unconfigured");
  });
});

describe("GET /api/plugins toolCount (connected dynamic services)", () => {
  function dynamicPlugin(resolveCalls: { count: number }): ValetPlugin {
    return {
      name: "dyn",
      version: "0.1.0",
      actions: [
        {
          service: "dyn",
          actions: [],
          resolveActions: async () => {
            resolveCalls.count += 1;
            return [pingAction("dyn.a"), pingAction("dyn.b"), pingAction("dyn.c")];
          },
        },
      ],
      credentials: [{ service: "dyn", type: "api_key", configKeys: ["apiKey"] }],
    };
  }

  it("reports the resolved count once connected, and never resolves while disconnected", async () => {
    const resolveCalls = { count: 0 };
    api = await bootTestApi({ plugins: [dynamicPlugin(resolveCalls)] });

    const before = await fetch(`${api.baseUrl}/api/plugins`);
    const beforeBody = (await before.json()) as ListPluginsResponse;
    expect(beforeBody.plugins.find((p) => p.name === "dyn")?.services[0]?.toolCount).toBeUndefined();
    expect(resolveCalls.count).toBe(0);

    await fetch(`${api.baseUrl}/api/credentials/dyn`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api_key", apiKey: "k-1" }),
    });

    const after = await fetch(`${api.baseUrl}/api/plugins`);
    const afterBody = (await after.json()) as ListPluginsResponse;
    expect(afterBody.plugins.find((p) => p.name === "dyn")?.services[0]?.toolCount).toBe(3);
    expect(resolveCalls.count).toBe(1);

    // TTL cache: a second listing serves the cached count without re-resolving.
    await fetch(`${api.baseUrl}/api/plugins`);
    expect(resolveCalls.count).toBe(1);
  });

  it("fails soft to no toolCount when resolveActions rejects", async () => {
    const plugin: ValetPlugin = {
      name: "dyn",
      version: "0.1.0",
      actions: [
        {
          service: "dyn",
          actions: [],
          resolveActions: async () => {
            throw new Error("mcp unreachable");
          },
        },
      ],
      credentials: [{ service: "dyn", type: "api_key", configKeys: ["apiKey"] }],
    };
    api = await bootTestApi({ plugins: [plugin] });
    await fetch(`${api.baseUrl}/api/credentials/dyn`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "api_key", apiKey: "k-1" }),
    });

    const res = await fetch(`${api.baseUrl}/api/plugins`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as ListPluginsResponse;
    expect(body.plugins.find((p) => p.name === "dyn")?.services[0]?.toolCount).toBeUndefined();
  });
});

/**
 * The per-service `actions` array backs the connect screen's central claim —
 * "your assistant gets these tools, and these ones stop to ask you first".
 * These pin the two properties that make the claim safe to print: the
 * approval flag comes from the engine's rule, and the join is the credential
 * key the runtime reads, so a mismatch under-reports instead of inventing.
 */
describe("GET /api/plugins — actions a credential unlocks", () => {
  function riskyAction(id: string, riskLevel: PluginAction["riskLevel"]): PluginAction {
    return { ...pingAction(id), riskLevel };
  }

  it("reports each action's risk and whether the approval gate stops it", async () => {
    const plugin: ValetPlugin = {
      name: "mixed",
      version: "0.1.0",
      actions: [
        {
          service: "mixed",
          actions: [
            riskyAction("mixed.read", "low"),
            riskyAction("mixed.update", "medium"),
            riskyAction("mixed.send", "high"),
            riskyAction("mixed.purge", "critical"),
          ],
        },
      ],
      credentials: [{ service: "mixed", type: "api_key", configKeys: ["apiKey"] }],
    };
    api = await bootTestApi({ plugins: [plugin] });

    const res = await fetch(`${api.baseUrl}/api/plugins`);
    const { plugins } = (await res.json()) as ListPluginsResponse;
    const actions = plugins.find((p) => p.name === "mixed")?.services[0]?.actions ?? [];

    expect(actions).toHaveLength(4);
    expect(actions.map((a) => a.name)).toEqual([
      "mixed.read",
      "mixed.update",
      "mixed.send",
      "mixed.purge",
    ]);
    // low/medium run; high/critical ask first.
    expect(actions.map((a) => a.requiresApproval)).toEqual([false, false, true, true]);
  });

  it("honours a plugin's defaultApprovalMode over its actions' risk levels", async () => {
    const plugin: ValetPlugin = {
      name: "trusted",
      version: "0.1.0",
      actions: [
        {
          service: "trusted",
          // Pinned "allow" outranks risk. A client re-deriving the flag from
          // `riskLevel` alone would promise a gate that never fires.
          defaultApprovalMode: "allow",
          actions: [riskyAction("trusted.purge", "critical")],
        },
      ],
      credentials: [{ service: "trusted", type: "api_key", configKeys: ["apiKey"] }],
    };
    api = await bootTestApi({ plugins: [plugin] });

    const res = await fetch(`${api.baseUrl}/api/plugins`);
    const { plugins } = (await res.json()) as ListPluginsResponse;
    const actions = plugins.find((p) => p.name === "trusted")?.services[0]?.actions ?? [];

    expect(actions).toHaveLength(1);
    expect(actions[0]?.riskLevel).toBe("critical");
    expect(actions[0]?.requiresApproval).toBe(false);
  });

  it("reports no actions when the credential key the tools read differs from the one declared", async () => {
    // The skewed shape: the connect UI writes the declaration's key
    // while the actions read `credentialService`. Connecting the declared key
    // unlocks nothing, so the row must not borrow the plugin's action list.
    const plugin: ValetPlugin = {
      name: "skewed",
      version: "0.1.0",
      actions: [
        {
          service: "skewed",
          credentialService: "skewed_underscored",
          actions: [pingAction("skewed.list")],
        },
      ],
      credentials: [{ service: "skewed", type: "api_key", configKeys: ["apiKey"] }],
    };
    api = await bootTestApi({ plugins: [plugin] });

    const res = await fetch(`${api.baseUrl}/api/plugins`);
    const { plugins } = (await res.json()) as ListPluginsResponse;
    const skewed = plugins.find((p) => p.name === "skewed");

    // The plugin still counts its action at the plugin level…
    expect(skewed?.actionCount).toBe(1);
    // …but the credential a user can actually connect unlocks none of it.
    expect(skewed?.services[0]?.actions).toEqual([]);
  });

  it("reports no actions for a dynamic service, whose tools resolve only after connecting", async () => {
    api = await bootTestApi({ plugins: [FIXTURE_PLUGIN] });

    const res = await fetch(`${api.baseUrl}/api/plugins`);
    const { plugins } = (await res.json()) as ListPluginsResponse;
    const fixture = plugins.find((p) => p.name === "fixture-plugin")?.services[0];

    expect(fixture?.dynamic).toBe(true);
    // Static actions still list; `resolveActions`' extra tool is not among
    // them, because it does not exist until a credential is connected.
    expect(fixture?.actions.map((a) => a.name)).toEqual(["fixture.ping", "fixture.pong"]);
  });
});
