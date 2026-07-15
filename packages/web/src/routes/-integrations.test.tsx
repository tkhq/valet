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

const connectMutateAsync = vi.fn().mockResolvedValue({ ok: true });
const disconnectMutateAsync = vi.fn().mockResolvedValue({ ok: true });

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/api/integrations", () => ({
  usePlugins: () => ({ data: pluginsData, isLoading: false, error: null }),
  useConnectCredential: () => ({ mutateAsync: connectMutateAsync, isPending: false, error: null }),
  useDisconnectCredential: () => ({ mutateAsync: disconnectMutateAsync, isPending: false, error: null }),
}));

import { IntegrationsPage } from "./integrations";

describe("IntegrationsPage", () => {
  beforeEach(() => {
    connectMutateAsync.mockClear();
    disconnectMutateAsync.mockClear();
    vi.spyOn(window, "confirm").mockReturnValue(true);
  });

  it("groups services vs built-in with friendly names and honest reach meta", () => {
    render(<IntegrationsPage />);

    // Friendly names, not raw ids.
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.getByText("Typefully")).toBeTruthy();
    expect(screen.getByText("DeepWiki")).toBeTruthy();
    expect(screen.getByText("Sandbox tunnels")).toBeTruthy();
    expect(screen.queryByText("github")).toBeNull();

    // Reach meta per shape.
    expect(screen.getByText("29 tools")).toBeTruthy();
    expect(screen.getByText("tools load on connect")).toBeTruthy(); // typefully: dynamic + credential
    expect(screen.getByText("no key needed")).toBeTruthy(); // deepwiki: dynamic, no credential
    expect(screen.getByText("built in")).toBeTruthy(); // sandbox-tunnels

    // Group headings present; the old per-card noise is gone.
    expect(screen.getByText("Services")).toBeTruthy();
    expect(screen.getByText("Built in")).toBeTruthy();
    expect(screen.queryByText("Nothing to connect for this plugin.")).toBeNull();
    expect(screen.queryByText(/0 actions/)).toBeNull();

    // Connected state.
    expect(screen.getByText("Connected")).toBeTruthy();
  });

  it("built-in plugins get no connect affordance; deepwiki (keyless) gets none either", () => {
    render(<IntegrationsPage />);
    // Only github + typefully are connectable → exactly two Connect buttons.
    expect(screen.getAllByRole("button", { name: "Connect" })).toHaveLength(2);
  });

  it("reveals the token form and connects via PUT — the action is named Connect throughout", async () => {
    render(<IntegrationsPage />);

    // Typefully's Connect (api_key) — buttons are ordered by display name (GitHub first).
    const [, typefullyConnect] = screen.getAllByRole("button", { name: "Connect" });
    fireEvent.click(typefullyConnect);

    const textarea = screen.getByLabelText("API key") as HTMLTextAreaElement;
    expect(screen.getByText("Typefully API key")).toBeTruthy(); // connectLabel as guidance copy
    fireEvent.change(textarea, { target: { value: "tf-key-123" } });

    // The form's submit is also "Connect" (never "Save").
    const buttons = screen.getAllByRole("button", { name: "Connect" });
    fireEvent.click(buttons[buttons.length - 1]);

    await waitFor(() => expect(connectMutateAsync).toHaveBeenCalledTimes(1));
    expect(connectMutateAsync).toHaveBeenCalledWith({
      service: "typefully",
      body: { type: "api_key", apiKey: "tf-key-123" },
    });
  });

  it("confirms then disconnects a connected service", async () => {
    render(<IntegrationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(disconnectMutateAsync).toHaveBeenCalledWith("slack"));
  });
});
