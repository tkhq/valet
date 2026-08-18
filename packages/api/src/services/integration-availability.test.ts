import { describe, expect, it } from "vitest";
import { Type } from "typebox";
import {
  InMemoryCredentialStore,
  type ActionPlugin,
  type CredentialDeclaration,
  type PluginAction,
  type ValetPlugin,
} from "@valet/engine";
import {
  connectModeFor,
  gateUnavailableActions,
  missingClientEnv,
  orgProvidedServiceSet,
  unavailableServiceSet,
} from "./integration-availability.js";

const ORG = "org-1";

function makeAction(id: string): PluginAction {
  return {
    id,
    name: id,
    description: id,
    riskLevel: "low",
    parameters: Type.Object({}),
    execute: async () => ({ success: true }),
  };
}

function makeActionPlugin(service: string): ActionPlugin {
  return { service, actions: [makeAction(`${service}.do_thing`)] };
}

function makePlugin(name: string, opts: Partial<ValetPlugin> = {}): ValetPlugin {
  return { name, version: "0.0.1", ...opts };
}

/** A store with an org-scoped credential already saved for `service`. */
async function storeWithOrgCredential(service: string): Promise<InMemoryCredentialStore> {
  const store = new InMemoryCredentialStore();
  await store.save({ type: "org", id: ORG }, service, { type: "bot_token", accessToken: "xoxb-1" });
  return store;
}

function resolve(params: {
  plugins: ValetPlugin[];
  decl: CredentialDeclaration;
  service: string;
  credentials?: InMemoryCredentialStore;
  env?: Record<string, string | undefined>;
}) {
  return connectModeFor({
    plugins: params.plugins,
    decl: params.decl,
    service: params.service,
    orgId: ORG,
    credentials: params.credentials ?? new InMemoryCredentialStore(),
    env: params.env ?? {},
  });
}

describe("connectModeFor", () => {
  it("mcp-mode oauth is \"oauth\" regardless of env", async () => {
    const decl: CredentialDeclaration = {
      type: "oauth2",
      configKeys: ["accessToken"],
      oauth: { mode: "mcp", serverUrl: "https://mcp.example.com" },
    };
    const plugins = [makePlugin("figma", { credentials: [decl] })];

    await expect(resolve({ plugins, decl, service: "figma" })).resolves.toBe("oauth");
  });

  it("authorization_code with both client env vars is \"oauth\"", async () => {
    const decl: CredentialDeclaration = {
      type: "oauth2",
      configKeys: ["accessToken"],
      oauth: {
        mode: "authorization_code",
        authorizationUrl: "https://accounts.example.com/auth",
        tokenUrl: "https://accounts.example.com/token",
        clientIdEnv: "GOOGLE_CLIENT_ID",
        clientSecretEnv: "GOOGLE_CLIENT_SECRET",
      },
    };
    const plugins = [makePlugin("google-workspace", { credentials: [decl] })];

    await expect(
      resolve({
        plugins,
        decl,
        service: "google-workspace",
        env: { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" },
      }),
    ).resolves.toBe("oauth");
  });

  it("authorization_code with a missing client env var is \"unconfigured\", not manual", async () => {
    const decl: CredentialDeclaration = {
      type: "oauth2",
      configKeys: ["accessToken"],
      oauth: {
        mode: "authorization_code",
        authorizationUrl: "https://accounts.example.com/auth",
        tokenUrl: "https://accounts.example.com/token",
        clientIdEnv: "GOOGLE_CLIENT_ID",
        clientSecretEnv: "GOOGLE_CLIENT_SECRET",
      },
    };
    const plugins = [makePlugin("google-workspace", { credentials: [decl] })];

    await expect(
      resolve({ plugins, decl, service: "google-workspace", env: { GOOGLE_CLIENT_ID: "id" } }),
    ).resolves.toBe("unconfigured");
  });

  it("requires.orgCredential with the org credential stored is \"org\" — no personal token entry", async () => {
    const decl: CredentialDeclaration = {
      type: "bot_token",
      configKeys: ["accessToken"],
      requires: { orgCredential: true },
    };
    const plugins = [makePlugin("slack", { credentials: [decl] })];

    await expect(
      resolve({ plugins, decl, service: "slack", credentials: await storeWithOrgCredential("slack") }),
    ).resolves.toBe("org");
  });

  it("requires.orgCredential with no org credential is \"unconfigured\"", async () => {
    const decl: CredentialDeclaration = {
      type: "bot_token",
      configKeys: ["accessToken"],
      requires: { orgCredential: true },
    };
    const plugins = [makePlugin("slack", { credentials: [decl] })];

    await expect(resolve({ plugins, decl, service: "slack" })).resolves.toBe("unconfigured");
  });

  it("a declaration with no oauth and no requires is \"manual\"", async () => {
    const decl: CredentialDeclaration = { type: "api_key", configKeys: ["apiKey"] };
    const plugins = [makePlugin("linear", { credentials: [decl] })];

    await expect(resolve({ plugins, decl, service: "linear" })).resolves.toBe("manual");
  });
});

describe("missingClientEnv", () => {
  function authCodePlugin(name: string, clientIdEnv: string, clientSecretEnv: string): ValetPlugin {
    return makePlugin(name, {
      credentials: [
        {
          type: "oauth2",
          configKeys: ["accessToken"],
          oauth: {
            mode: "authorization_code",
            authorizationUrl: "https://accounts.example.com/auth",
            tokenUrl: "https://accounts.example.com/token",
            clientIdEnv,
            clientSecretEnv,
          },
        },
      ],
    });
  }

  it("names both client variables when neither is set", () => {
    const plugins = [authCodePlugin("gmail", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")];

    expect(missingClientEnv(plugins, "gmail", {})).toEqual([
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ]);
  });

  it("names only the unset half of a half-set pair", () => {
    const plugins = [authCodePlugin("gmail", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")];

    expect(missingClientEnv(plugins, "gmail", { GOOGLE_CLIENT_ID: "id" })).toEqual([
      "GOOGLE_CLIENT_SECRET",
    ]);
  });

  it("is empty once both are set", () => {
    const plugins = [authCodePlugin("gmail", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")];

    expect(
      missingClientEnv(plugins, "gmail", { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" }),
    ).toEqual([]);
  });

  it("reads each plugin's OWN variable names, so a second plugin needs no code change", () => {
    const plugins = [
      authCodePlugin("gmail", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"),
      authCodePlugin("dropbox", "DROPBOX_CLIENT_ID", "DROPBOX_CLIENT_SECRET"),
    ];

    expect(missingClientEnv(plugins, "dropbox", {})).toEqual([
      "DROPBOX_CLIENT_ID",
      "DROPBOX_CLIENT_SECRET",
    ]);
  });

  it("carries names, never the values behind them", () => {
    const plugins = [authCodePlugin("gmail", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET")];
    // One half set to a secret-shaped value: the other half's NAME comes
    // back, and the set value appears nowhere in the result.
    const result = missingClientEnv(plugins, "gmail", { GOOGLE_CLIENT_ID: "super-secret-value" });

    expect(result).toEqual(["GOOGLE_CLIENT_SECRET"]);
    expect(JSON.stringify(result)).not.toContain("super-secret-value");
  });

  it("is empty for an mcp-mode declaration, which needs no local client", () => {
    const plugins = [
      makePlugin("figma", {
        credentials: [
          {
            type: "oauth2",
            configKeys: ["accessToken"],
            oauth: { mode: "mcp", serverUrl: "https://mcp.example.com" },
          },
        ],
      }),
    ];

    expect(missingClientEnv(plugins, "figma", {})).toEqual([]);
  });

  it("is empty for an org-credential prerequisite, whose fix is not a variable", () => {
    const plugins = [
      makePlugin("slack", {
        credentials: [
          { type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } },
        ],
      }),
    ];

    expect(missingClientEnv(plugins, "slack", {})).toEqual([]);
  });

  it("is empty for a service no plugin declares", () => {
    expect(missingClientEnv([], "nobody", {})).toEqual([]);
  });
});

describe("unavailableServiceSet", () => {
  it("returns exactly the services that resolve unconfigured", async () => {
    const slack = makePlugin("slack", {
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    });
    const linear = makePlugin("linear", {
      credentials: [{ type: "api_key", configKeys: ["apiKey"] }],
    });
    const google = makePlugin("google-workspace", {
      credentials: [
        {
          type: "oauth2",
          configKeys: ["accessToken"],
          oauth: {
            mode: "authorization_code",
            authorizationUrl: "https://accounts.example.com/auth",
            tokenUrl: "https://accounts.example.com/token",
            clientIdEnv: "GOOGLE_CLIENT_ID",
            clientSecretEnv: "GOOGLE_CLIENT_SECRET",
          },
        },
      ],
    });

    const unavailable = await unavailableServiceSet({
      plugins: [slack, linear, google],
      orgId: ORG,
      credentials: new InMemoryCredentialStore(),
      env: {},
    });

    expect(unavailable).toEqual(new Set(["slack", "google-workspace"]));
  });

  it("drops a service from the set once its org credential exists", async () => {
    const slack = makePlugin("slack", {
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    });

    const unavailable = await unavailableServiceSet({
      plugins: [slack],
      orgId: ORG,
      credentials: await storeWithOrgCredential("slack"),
      env: {},
    });

    expect(unavailable).toEqual(new Set());
  });
});

describe("orgProvidedServiceSet", () => {
  it("is empty before an admin connects the org credential", async () => {
    const slack = makePlugin("slack", {
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    });

    const provided = await orgProvidedServiceSet({
      plugins: [slack],
      orgId: ORG,
      credentials: new InMemoryCredentialStore(),
      env: {},
    });

    expect(provided).toEqual(new Set());
  });

  it("names the service once its org credential exists — the fact no member's own credential list carries", async () => {
    // This is the set `listWorkflowTemplateSummaries` unions into
    // `connected`: an org-scoped credential is never on any ONE member's own
    // list, and reading only that list is the bug this closes — a card
    // offering "Connect Slack" to a member for a service their organization
    // already connected, which member never can do themselves.
    const slack = makePlugin("slack", {
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
    });

    const provided = await orgProvidedServiceSet({
      plugins: [slack],
      orgId: ORG,
      credentials: await storeWithOrgCredential("slack"),
      env: {},
    });

    expect(provided).toEqual(new Set(["slack"]));
  });

  it("never names a personal-oauth or manual-token service, whatever is connected", async () => {
    const linear = makePlugin("linear", {
      credentials: [{ type: "api_key", configKeys: ["apiKey"] }],
    });
    const google = makePlugin("google-workspace", {
      credentials: [
        {
          type: "oauth2",
          configKeys: ["accessToken"],
          oauth: {
            mode: "authorization_code",
            authorizationUrl: "https://accounts.example.com/auth",
            tokenUrl: "https://accounts.example.com/token",
            clientIdEnv: "GOOGLE_CLIENT_ID",
            clientSecretEnv: "GOOGLE_CLIENT_SECRET",
          },
        },
      ],
    });

    const provided = await orgProvidedServiceSet({
      plugins: [linear, google],
      orgId: ORG,
      credentials: new InMemoryCredentialStore(),
      env: { GOOGLE_CLIENT_ID: "id", GOOGLE_CLIENT_SECRET: "secret" },
    });

    expect(provided).toEqual(new Set());
  });
});

describe("gateUnavailableActions", () => {
  it("strips ActionPlugins whose credential key is unavailable, keeps the rest of the plugin", () => {
    const slack = makePlugin("slack", {
      actions: [makeActionPlugin("slack")],
      credentials: [{ type: "bot_token", configKeys: ["accessToken"], requires: { orgCredential: true } }],
      skills: [{ name: "slack-tools", description: "s", content: "c", source: "plugin" }],
    });
    const linear = makePlugin("linear", {
      actions: [makeActionPlugin("linear")],
      credentials: [{ type: "api_key", configKeys: ["apiKey"] }],
    });

    const gated = gateUnavailableActions([slack, linear], new Set(["slack"]));

    const gatedSlack = gated.find((p) => p.name === "slack");
    expect(gatedSlack?.actions).toEqual([]);
    expect(gatedSlack?.credentials).toEqual(slack.credentials);
    expect(gatedSlack?.skills).toEqual(slack.skills);
    expect(gated.find((p) => p.name === "linear")).toBe(linear);
  });

  it("joins on credentialService when the ActionPlugin overrides it", () => {
    const calendar = makePlugin("google-calendar", {
      actions: [{ ...makeActionPlugin("google_calendar"), credentialService: "google-calendar" }],
      credentials: [{ type: "oauth2", configKeys: ["accessToken"] }],
    });

    const gated = gateUnavailableActions([calendar], new Set(["google-calendar"]));

    expect(gated[0]?.actions).toEqual([]);
  });

  it("is identity when nothing is unavailable", () => {
    const linear = makePlugin("linear", { actions: [makeActionPlugin("linear")] });

    expect(gateUnavailableActions([linear], new Set())).toEqual([linear]);
  });
});
