// @vitest-environment jsdom
/**
 * `/settings/connected-accounts` — Telegram identity linking (Task 11).
 * Mocks `~/api/queries` the same way `-settings.sections.test.tsx` mocks it
 * for the notifications toggle: these tests only care what the page renders
 * and which mutation it fires, not that TanStack Query itself resolves
 * anything.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { IdentityLinkStatus } from "@valet/api/wire";

const startMutateAsync = vi.fn();
const setNotifyMutate = vi.fn();
const unlinkMutate = vi.fn();

let linksData: { links: IdentityLinkStatus[] } | undefined;
let isLoading = false;
let isError = false;

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/api/queries", () => ({
  useIdentityLinks: () => ({ data: linksData, isLoading, error: isError ? new Error("boom") : null }),
  useStartIdentityLink: () => ({ mutateAsync: startMutateAsync, isPending: false }),
  useSetLinkNotify: () => ({ mutate: setNotifyMutate }),
  useUnlinkIdentity: () => ({ mutate: unlinkMutate, isPending: false }),
}));

import { ConnectedAccountsPage } from "./settings.connected-accounts";

describe("ConnectedAccountsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    linksData = undefined;
    isLoading = false;
    isError = false;
  });

  it("shows a loading spinner row", () => {
    isLoading = true;
    render(<ConnectedAccountsPage />);
    expect(screen.getByText("Loading…")).toBeTruthy();
  });

  it("shows failure text on error", () => {
    isError = true;
    render(<ConnectedAccountsPage />);
    expect(screen.getByText("Failed to load connected accounts.")).toBeTruthy();
  });

  it("shows the unconfigured copy with no buttons when channelReady is false", () => {
    linksData = {
      links: [{ provider: "telegram", linked: false, channelReady: false }],
    };
    render(<ConnectedAccountsPage />);
    expect(
      screen.getByText(
        "Telegram isn't configured for this organization yet. An admin can add a bot token under Integrations.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect Telegram" })).toBeNull();
  });

  it("connecting starts the link flow and renders the deep link", async () => {
    linksData = {
      links: [{ provider: "telegram", linked: false, channelReady: true }],
    };
    startMutateAsync.mockResolvedValue({
      deepLink: "https://t.me/valet_bot?start=abc123",
      expiresInSeconds: 600,
    });
    render(<ConnectedAccountsPage />);

    fireEvent.click(screen.getByRole("button", { name: "Connect Telegram" }));

    await waitFor(() => expect(startMutateAsync).toHaveBeenCalled());
    expect(
      await screen.findByRole("link", { name: "Open Telegram and press Start" }),
    ).toHaveProperty("href", "https://t.me/valet_bot?start=abc123");
    expect(screen.getByText("https://t.me/valet_bot?start=abc123")).toBeTruthy();
    expect(screen.getByText(/expires in 10 minutes/)).toBeTruthy();
  });

  it("linked state shows externalId, linked-since, a notify switch, and disconnect", () => {
    linksData = {
      links: [
        {
          provider: "telegram",
          linked: true,
          channelReady: true,
          externalId: "123456789",
          notifyAttention: true,
          createdAt: Date.parse("2026-01-01T00:00:00Z"),
        },
      ],
    };
    render(<ConnectedAccountsPage />);

    expect(screen.getByText("123456789")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Notify on attention" });
    fireEvent.click(toggle);
    expect(setNotifyMutate).toHaveBeenCalledWith({ notifyAttention: false });

    fireEvent.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(unlinkMutate).toHaveBeenCalled();
  });
});
