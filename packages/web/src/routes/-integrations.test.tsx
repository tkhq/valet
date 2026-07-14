// @vitest-environment jsdom
/**
 * `/integrations` connect surface (plugin-system-v2 plan Task 15): a card
 * per plugin, one row per declared credential service, a reveal-form
 * Connect flow, and a confirm-gated Disconnect. Mocks `~/api/integrations`
 * the same way `-workflows.index.test.tsx` mocks `~/api/workflows` — this
 * suite only cares that the page renders from query data and calls the
 * right mutation, not that TanStack Query itself works.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const pluginsData = {
  plugins: [
    {
      name: "fixture-plugin",
      version: "0.1.0",
      description: "A fixture plugin",
      actionCount: 3,
      services: [
        {
          service: "fixture",
          type: "api_key" as const,
          configKeys: ["apiKey"],
          connectLabel: "Fixture API key",
          connected: false,
        },
      ],
    },
    {
      name: "connected-plugin",
      version: "1.0.0",
      actionCount: 1,
      services: [
        {
          service: "connected-service",
          type: "oauth2" as const,
          configKeys: ["accessToken"],
          connected: true,
        },
      ],
    },
    {
      name: "bare-plugin",
      version: "1.0.0",
      actionCount: 1,
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

  it("renders a card per plugin with its action count and service rows", () => {
    render(<IntegrationsPage />);

    expect(screen.getByText("fixture-plugin")).toBeTruthy();
    expect(screen.getByText("3 actions")).toBeTruthy();
    expect(screen.getByText("fixture")).toBeTruthy();
    expect(screen.getByText("Not connected")).toBeTruthy();

    expect(screen.getByText("connected-plugin")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();

    expect(screen.getByText("bare-plugin")).toBeTruthy();
    expect(screen.getByText("Nothing to connect for this plugin.")).toBeTruthy();
  });

  it("reveals the connect form and saves a token via PUT", async () => {
    render(<IntegrationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    const textarea = screen.getByLabelText("API key") as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "sk-fixture-123" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(connectMutateAsync).toHaveBeenCalledTimes(1));
    expect(connectMutateAsync).toHaveBeenCalledWith({
      service: "fixture",
      body: { type: "api_key", apiKey: "sk-fixture-123" },
    });
  });

  it("confirms then disconnects a connected service", async () => {
    render(<IntegrationsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));

    expect(window.confirm).toHaveBeenCalled();
    await waitFor(() => expect(disconnectMutateAsync).toHaveBeenCalledWith("connected-service"));
  });
});
