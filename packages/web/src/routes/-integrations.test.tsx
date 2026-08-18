// @vitest-environment jsdom
/**
 * `/integrations` (post-facelift): Services vs Built-in grouping, friendly
 * display names, honest reach meta ("N tools" / "no key needed" /
 * "built in"), the token reveal-form Connect flow (the action is named
 * "Connect" end to end), and confirm-gated Disconnect. Mocks
 * `~/api/integrations` the same way `-workflows.index.test.tsx` mocks its
 * api module — this suite cares that the page renders from query data and
 * calls the right mutation, not that TanStack Query works.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type {
  GetGithubOrgStatusResponse,
  ListPluginsResponse,
  OrgResponse,
  PluginServiceSummary,
} from "@valet/api/wire";

const pluginsData = {
  plugins: [
    {
      name: "github",
      version: "0.1.0",
      description: "GitHub integration for PRs, issues, repos, and webhooks",
      actionCount: 29,
      services: [
        {
          service: "github",
          type: "oauth2" as const,
          configKeys: ["accessToken"],
          connectLabel: "Connect GitHub (via GitHub App)",
          connected: false,
          connect: "manual" as const,
          actions: [],
        },
      ],
    },
    {
      name: "typefully",
      version: "0.1.0",
      actionCount: 0,
      dynamic: true as const,
      services: [
        {
          service: "typefully",
          type: "api_key" as const,
          configKeys: ["accessToken"],
          connectLabel: "Typefully API key",
          connected: false,
          dynamic: true as const,
          connect: "manual" as const,
          actions: [],
        },
      ],
    },
    {
      name: "slack",
      version: "0.1.0",
      actionCount: 11,
      services: [
        {
          service: "slack",
          type: "bot_token" as const,
          configKeys: ["accessToken"],
          connected: true,
          connect: "manual" as const,
          actions: [],
        },
      ],
    },
    {
      // Dynamic tools, no credential declaration (the deepwiki shape) —
      // must land in Services with "no key needed", not in Built in.
      name: "deepwiki",
      version: "0.1.0",
      description: "DeepWiki integration for repository knowledge base",
      actionCount: 0,
      dynamic: true as const,
      services: [],
    },
    {
      // Content-only plugin — Built in group, no connect affordance.
      name: "sandbox-tunnels",
      version: "0.1.0",
      description: "Expose sandbox ports",
      actionCount: 0,
      services: [],
    },
  ],
};

const oauthPluginsData = {
  plugins: [
    {
      name: "linear",
      version: "0.1.0",
      description: "Linear issue tracking",
      // Linear resolves its tools from an MCP server, so it declares none
      // statically and reports `dynamic` — the real shape on the wire.
      actionCount: 0,
      dynamic: true as const,
      services: [
        {
          service: "linear",
          type: "oauth2" as const,
          configKeys: ["accessToken"],
          connected: false,
          connect: "oauth" as const,
          dynamic: true as const,
          actions: [],
        },
      ],
    },
  ],
};

const manualOnlyPluginsData = {
  plugins: [
    {
      name: "typefully",
      version: "0.1.0",
      actionCount: 0,
      dynamic: true as const,
      services: [
        {
          service: "typefully",
          type: "api_key" as const,
          configKeys: ["accessToken"],
          connectLabel: "Typefully API key",
          connected: false,
          dynamic: true as const,
          connect: "manual" as const,
          actions: [],
        },
      ],
    },
  ],
};

const githubPluginsData: ListPluginsResponse = {
  plugins: [
    {
      name: "github",
      version: "0.1.0",
      description: "GitHub integration for PRs, issues, repos, and webhooks",
      actionCount: 29,
      services: [
        {
          service: "github",
          type: "oauth2" as const,
          configKeys: ["accessToken"],
          connected: false,
          connect: "manual" as const,
          actions: [],
        },
      ],
    },
  ],
};

let currentPluginsData: ListPluginsResponse = pluginsData;
let currentOrgStatus: GetGithubOrgStatusResponse | undefined;
let currentOrg: OrgResponse | undefined;

const connectMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const disconnectMutateAsync = vi.fn().mockResolvedValue({ ok: true });

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/api/settings", () => ({
  useMe: () => ({
    data: {
      id: "u1",
      email: "person@example.com",
      name: "Signed In Person",
      avatarUrl: null,
      role: "member",
      orgId: "o1",
      orgRole: "member",
      defaultModel: null,
    },
  }),
  useTeams: () => ({ data: { teams: [] } }),
  useOrg: () => ({ data: currentOrg }),
}));

vi.mock("~/api/repos", () => ({
  useConnectGithub: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useGithubOrgStatus: (enabled = true) => ({ data: enabled ? currentOrgStatus : undefined }),
}));

vi.mock("~/api/integrations", () => ({
  usePlugins: () => ({ data: currentPluginsData, isLoading: false, error: null }),
  useConnectCredential: () => ({ mutateAsync: connectMutateAsync, isPending: false, error: null }),
  useDisconnectCredential: () => ({ mutateAsync: disconnectMutateAsync, isPending: false, error: null }),
}));

import { IntegrationsPage } from "./integrations";

function org(callerRole: "admin" | "member", organizations = true): OrgResponse {
  return {
    id: "o1",
    name: "Acme",
    createdAt: 0,
    features: { organizations, ssoTeamSync: false },
    callerRole,
  };
}

describe("IntegrationsPage", () => {
  beforeEach(() => {
    currentPluginsData = pluginsData;
    currentOrgStatus = { configured: true, installationCount: 1, suspendedCount: 0 };
    currentOrg = org("member");
    connectMutateAsync.mockClear();
    disconnectMutateAsync.mockClear();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("lists connectable services only, with friendly names and honest reach meta", () => {
    render(<IntegrationsPage />);

    // Friendly names, not raw ids.
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("Typefully")).toBeTruthy();
    expect(screen.getByText("DeepWiki")).toBeTruthy();
    expect(screen.queryByText("github")).toBeNull();

    // Reach meta per shape.
    expect(screen.getByText("29 tools")).toBeTruthy();
    expect(screen.getByText("tools load on connect")).toBeTruthy(); // typefully: dynamic + credential
    expect(screen.getByText("no key needed")).toBeTruthy(); // deepwiki: dynamic, no credential

    // Content-only plugins are not listed at all. They need no credential
    // and offer no action, so their row was one nobody could use.
    expect(screen.queryByText("Sandbox tunnels")).toBeNull();
    expect(screen.queryByText("built in")).toBeNull();
    expect(screen.queryByText("Built in")).toBeNull();

    expect(screen.getByText("Services")).toBeTruthy();
    expect(screen.queryByText("Nothing to connect for this plugin.")).toBeNull();
    expect(screen.queryByText(/0 actions/)).toBeNull();

    // Connected state.
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("shows a config-declared MCP server by its displayName, never the mcp-config: id", () => {
    currentPluginsData = {
      plugins: [
        {
          name: "mcp-config:grafana",
          version: "0.0.0",
          displayName: "Grafana Cloud",
          description: "Grafana Cloud integration for dashboards and alerts",
          actionCount: 0,
          dynamic: true as const,
          services: [
            {
              service: "grafana",
              type: "oauth2" as const,
              configKeys: ["accessToken"],
              connected: false,
              connect: "oauth" as const,
              dynamic: true as const,
              actions: [],
            },
          ],
        },
        {
          // An api that predates `displayName` on the wire: the client
          // still strips the mcp-config: prefix before title-casing.
          name: "mcp-config:pylon",
          version: "0.0.0",
          actionCount: 0,
          dynamic: true as const,
          services: [],
        },
        {
          // Multi-word slug, no wire displayName: every word capitalizes,
          // matching the server's titleCaseSlug fallback.
          name: "mcp-config:pager-duty",
          version: "0.0.0",
          actionCount: 0,
          dynamic: true as const,
          services: [],
        },
      ],
    };
    render(<IntegrationsPage />);
    expect(screen.getByText("Grafana Cloud")).toBeTruthy();
    expect(screen.getByText("Pylon")).toBeTruthy();
    expect(screen.getByText("Pager Duty")).toBeTruthy();
    expect(screen.queryByText(/Mcp config/)).toBeNull();
  });

  it("built-in plugins get no connect affordance; deepwiki (keyless) gets none either", () => {
    render(<IntegrationsPage />);
    // Only github + typefully are connectable → exactly two Connect buttons.
    // Each names its own service, so a screen reader can tell them apart.
    expect(screen.getAllByRole("button", { name: /^Connect / })).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Typefully" })).toBeTruthy();
  });

  it("connects via PUT after the pre-connect screen — the action is named Connect throughout", async () => {
    render(<IntegrationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Connect Typefully" }));

    // The disclosure comes first; the token field is one step behind it.
    expect(screen.getByText("Set up your Typefully connection")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    const textarea = screen.getByLabelText("API key") as HTMLTextAreaElement;
    expect(screen.getByText("Typefully API key")).toBeTruthy(); // connectLabel as guidance copy
    fireEvent.change(textarea, { target: { value: "tf-key-123" } });

    // The submit is still "Connect" (never "Save").
    fireEvent.click(screen.getByRole("button", { name: "Connect Typefully" }));

    await waitFor(() => expect(connectMutateAsync).toHaveBeenCalledTimes(1));
    expect(connectMutateAsync).toHaveBeenCalledWith({
      service: "typefully",
      body: { type: "api_key", apiKey: "tf-key-123" },
    });
  });

  it("confirms then disconnects a connected service", async () => {
    render(<IntegrationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect Slack" }));

    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(disconnectMutateAsync).toHaveBeenCalledWith("slack"));
  });

  it("opens the pre-connect screen for an oauth service instead of redirecting on click", () => {
    // This used to be a bare anchor straight at /api/credentials/:s/connect,
    // which left no moment to say what the credential gives away.
    currentPluginsData = oauthPluginsData;
    render(<IntegrationsPage />);

    expect(screen.queryByRole("link", { name: "Connect Linear" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));

    expect(screen.getByText("Set up your Linear connection")).toBeTruthy();
    expect(screen.getByLabelText("What your assistant can do")).toBeTruthy();
    expect(screen.getByLabelText("Who can reach it")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Continue" })).toBeTruthy();
  });

  it("oauth services still offer manual token entry, behind the disclosure", () => {
    currentPluginsData = oauthPluginsData;
    render(<IntegrationsPage />);
    fireEvent.click(screen.getByRole("button", { name: "Connect Linear" }));
    fireEvent.click(screen.getByRole("button", { name: "Enter a token instead" }));
    expect(screen.getByLabelText("Access token")).toBeTruthy();
  });

  it("manual services render the token-entry Connect button, not an anchor", () => {
    currentPluginsData = manualOnlyPluginsData;
    render(<IntegrationsPage />);
    expect(screen.queryByRole("link", { name: "Connect Typefully" })).toBeNull();
    expect(screen.getByRole("button", { name: "Connect Typefully" })).toBeTruthy();
  });

  it("shows a success notice for ?connected= and an error notice for ?error=", () => {
    window.history.replaceState(null, "", "/integrations?connected=linear");
    const { unmount } = render(<IntegrationsPage />);
    expect(screen.getByText(/Connected linear/i)).toBeTruthy();
    unmount();

    window.history.replaceState(null, "", "/integrations?error=access_denied");
    render(<IntegrationsPage />);
    expect(screen.getByText(/access_denied/)).toBeTruthy();
  });
});

describe("brand marks", () => {
  it("draws a different mark per service instead of one letter each", () => {
    currentPluginsData = {
      plugins: ["github", "gmail", "google-calendar"].map((name) => ({
        name,
        version: "0.1.0",
        actionCount: 1,
        services: [
          {
            service: name,
            type: "oauth2" as const,
            configKeys: ["accessToken"],
            connected: false,
            connect: "manual" as const,
            actions: [],
            iconSlug: name,
          },
        ],
      })),
    };
    const { container } = render(<IntegrationsPage />);
    const paths = [...container.querySelectorAll("svg path")].map((p) => p.getAttribute("d"));
    expect(paths).toHaveLength(3);
    expect(new Set(paths).size).toBe(3);
  });
});

describe("connection health", () => {
  function connectedGmail(health: PluginServiceSummary["health"]): ListPluginsResponse {
    return {
      plugins: [
        {
          name: "gmail",
          version: "0.1.0",
          actionCount: 6,
          services: [
            {
              service: "gmail",
              type: "oauth2" as const,
              configKeys: ["accessToken"],
              connected: true,
              connect: "oauth" as const,
              actions: [],
              iconSlug: "gmail",
              health,
            },
          ],
        },
      ],
    };
  }

  it("names the connected account", () => {
    currentPluginsData = connectedGmail({ login: "someone@example.com" });
    render(<IntegrationsPage />);
    expect(screen.getByText(/someone@example.com/)).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect Gmail" })).toBeNull();
  });

  it("shows the fix and a Reconnect control when the token expired", () => {
    currentPluginsData = connectedGmail({ login: "someone@example.com", expiresAt: Date.now() - 1000 });
    render(<IntegrationsPage />);

    expect(screen.getByText("Expired")).toBeTruthy();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.getByText(/Select Reconnect to sign in again/)).toBeTruthy();
    // The repair opens the same pre-connect screen, and Disconnect stays available.
    expect(screen.queryByRole("link", { name: "Reconnect Gmail" })).toBeNull();
    expect(screen.getByRole("button", { name: "Reconnect Gmail" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Gmail" })).toBeTruthy();
  });

  it("shows the fix when the last refresh failed", () => {
    currentPluginsData = connectedGmail({ refreshFailed: true });
    render(<IntegrationsPage />);
    expect(screen.getByText("Refresh failed")).toBeTruthy();
    expect(screen.getByText(/The last token refresh failed/)).toBeTruthy();
  });

  it("shows the fix when the grant carries identity only", () => {
    currentPluginsData = connectedGmail({ identityOnly: true });
    render(<IntegrationsPage />);
    expect(screen.getByText("Sign-in only")).toBeTruthy();
    expect(screen.getByText(/add the permissions the tools need/)).toBeTruthy();
  });

  it("keeps the plain Connected badge when the wire reports no health", () => {
    currentPluginsData = connectedGmail(undefined);
    render(<IntegrationsPage />);
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect Gmail" })).toBeNull();
  });
});

describe("connected dynamic service tool count", () => {
  it("shows the resolved toolCount instead of 'tools load on connect' once connected", () => {
    currentPluginsData = {
      plugins: [
        {
          name: "linear",
          version: "0.1.0",
          actionCount: 0,
          dynamic: true as const,
          services: [
            {
              service: "linear",
              type: "oauth2" as const,
              configKeys: ["accessToken"],
              connected: true,
              dynamic: true as const,
              connect: "oauth" as const,
              actions: [],
              toolCount: 52,
            },
          ],
        },
      ],
    };
    render(<IntegrationsPage />);
    expect(screen.getByText("52 tools")).toBeTruthy();
    expect(screen.queryByText("tools load on connect")).toBeNull();
  });

  it("keeps the static label when connected but toolCount is absent (resolution failed)", () => {
    currentPluginsData = {
      plugins: [
        {
          name: "linear",
          version: "0.1.0",
          actionCount: 0,
          dynamic: true as const,
          services: [
            {
              service: "linear",
              type: "oauth2" as const,
              configKeys: ["accessToken"],
              connected: true,
              dynamic: true as const,
              connect: "oauth" as const,
              actions: [],
            },
          ],
        },
      ],
    };
    render(<IntegrationsPage />);
    expect(screen.getByText("tools load on connect")).toBeTruthy();
  });
});

/**
 * The organisation's GitHub App, on the GitHub card.
 *
 * An admin who set up an App found nothing here acknowledging it, and the
 * card offered the same plain "Connect" whether the organisation had three
 * installations or no App at all — in which case that button can only fail.
 * These assert the card reports the App's real state and points at the page
 * that owns it, without ever suggesting the App and the personal credential
 * are one connection.
 */
describe("the organisation's GitHub App", () => {
  beforeEach(() => {
    currentPluginsData = githubPluginsData;
    currentOrgStatus = { configured: true, installationCount: 2, suspendedCount: 0 };
    currentOrg = org("member");
  });

  it("counts the accounts the App reaches, and says the App is not the user", () => {
    render(<IntegrationsPage />);
    expect(screen.getByText("Org App installed")).toBeTruthy();
    expect(
      screen.getByText(/GitHub App reaches 2 GitHub accounts\. It acts as your organisation, not as you\./),
    ).toBeTruthy();
  });

  it("names the missed install and links an admin to the page that owns it", () => {
    // GitHub's creation flow ends without prompting for the install, so an
    // App with no installation is the state people actually land in.
    currentOrgStatus = { configured: true, installationCount: 0, suspendedCount: 0 };
    currentOrg = org("admin");
    render(<IntegrationsPage />);

    expect(screen.getByText("Org App not installed")).toBeTruthy();
    expect(screen.getByText(/nobody installed it on a GitHub account/)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Finish the install" });
    expect(link.getAttribute("href")).toBe("/settings/organization/github");
  });

  it("tells a member who to ask, rather than linking to a page they cannot open", () => {
    currentOrgStatus = { configured: true, installationCount: 0, suspendedCount: 0 };
    render(<IntegrationsPage />);

    expect(screen.getByText(/Ask an org admin to install it\./)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Finish the install" })).toBeNull();
  });

  it("hides the link from a gate-off admin, whose App page shows the same refusal", () => {
    currentOrg = org("admin", false);
    render(<IntegrationsPage />);
    expect(screen.queryByRole("link", { name: /App/ })).toBeNull();
  });

  it("says the organisation has no App on a disconnected card, where Connect is about to fail", () => {
    currentOrgStatus = { configured: false, installationCount: 0, suspendedCount: 0 };
    render(<IntegrationsPage />);

    // The card is disconnected, so the note stack used to render nothing at
    // all — which is the state that most needed the explanation.
    expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeTruthy();
    expect(screen.getByText("No org App")).toBeTruthy();
    expect(screen.getByText(/Valet signs you in to GitHub through that App/)).toBeTruthy();
  });

  it("reports a suspended App as reaching nothing, not as installed", () => {
    currentOrgStatus = { configured: true, installationCount: 2, suspendedCount: 2 };
    render(<IntegrationsPage />);
    expect(screen.getByText("Org App suspended")).toBeTruthy();
    expect(screen.queryByText(/reaches \d+ GitHub/)).toBeNull();
  });

  it("keeps the org App's badge distinct from the personal credential's", () => {
    currentPluginsData = {
      plugins: [
        {
          ...githubPluginsData.plugins[0],
          services: [{ ...githubPluginsData.plugins[0].services[0], connected: true }],
        },
      ],
    };
    render(<IntegrationsPage />);
    // Two connections, two badges. "Connected" is this user's credential;
    // the App carries its own label and never borrows that one.
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("Org App installed")).toBeTruthy();
  });

  it("claims nothing while the org status is unknown", () => {
    currentOrgStatus = undefined;
    render(<IntegrationsPage />);
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.queryByText(/Org App/)).toBeNull();
    expect(screen.queryByText(/No org App/)).toBeNull();
  });

  it("leaves every other service's card alone", () => {
    currentPluginsData = pluginsData;
    render(<IntegrationsPage />);
    // One GitHub card, one org line — Slack and Typefully have no org half.
    expect(screen.getAllByText(/Org App/)).toHaveLength(1);
  });
});

/**
 * Availability tri-state (integration-availability design): the wire says
 * "unconfigured" when the org/deployment prerequisite is missing. An
 * unconfigured, unconnected service does not render at all; a leftover
 * credential keeps its tile for Disconnect, with the admin note and no
 * Connect control.
 */
describe("unconfigured services", () => {
  const unconfiguredPluginsData: ListPluginsResponse = {
    plugins: [
      {
        name: "slack",
        version: "0.1.0",
        actionCount: 11,
        services: [
          {
            service: "slack",
            type: "bot_token" as const,
            configKeys: ["accessToken"],
            connected: false,
            connect: "unconfigured" as const,
            actions: [],
          },
        ],
      },
      {
        name: "gmail",
        version: "0.1.0",
        actionCount: 4,
        services: [
          {
            service: "gmail",
            type: "oauth2" as const,
            configKeys: ["accessToken"],
            connected: true,
            connect: "unconfigured" as const,
            actions: [],
          },
        ],
      },
      {
        name: "typefully",
        version: "0.1.0",
        actionCount: 0,
        dynamic: true as const,
        services: [
          {
            service: "typefully",
            type: "api_key" as const,
            configKeys: ["accessToken"],
            connected: false,
            connect: "manual" as const,
            actions: [],
          },
        ],
      },
    ],
  };

  beforeEach(() => {
    currentPluginsData = unconfiguredPluginsData;
    currentOrgStatus = { configured: true, installationCount: 1, suspendedCount: 0 };
    currentOrg = org("member");
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("hides an unconfigured, unconnected service from the grid", () => {
    render(<IntegrationsPage />);

    expect(screen.queryByText("Slack")).toBeNull();
    // A configured manual service still lists.
    expect(screen.getByText("Typefully")).toBeTruthy();
  });

  it("keeps a connected-but-unconfigured service visible for Disconnect, with the admin note", () => {
    render(<IntegrationsPage />);

    expect(screen.getByText("Gmail")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Gmail" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Connect Gmail/ })).toBeNull();
    expect(screen.getByText(/Not configured for this organization/)).toBeTruthy();
  });
});
