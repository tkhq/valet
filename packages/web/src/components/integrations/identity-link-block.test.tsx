// @vitest-environment jsdom
/**
 * Integrations · identity-link block. The unlink control is destructive: it
 * deletes the pairing between the provider account and the Valet account.
 * These tests pin the confirm step to a real dialog, not `window.confirm`,
 * which browser automation auto-accepts — so the first assertion is that a
 * click alone fires nothing.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { IdentityLinkStatus } from "@valet/api/wire";
import { ApiError } from "~/api/client";

const unlinkMutate = vi.fn();
let unlinkPending = false;
let unlinkError: Error | null = null;

vi.mock("~/api/queries", () => ({
  useIdentityLinks: () => ({ data: { links: [] }, isLoading: false, error: null }),
  useStartIdentityLink: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useDeliverIdentityLink: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useLinkMembers: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
  useUnlinkIdentity: () => ({
    mutate: unlinkMutate,
    isPending: unlinkPending,
    error: unlinkError,
    reset: vi.fn(),
  }),
}));

import { IdentityLinkBlock } from "./identity-link-block";

const LINKED: IdentityLinkStatus = {
  provider: "slack",
  linked: true,
  externalId: "U123",
  notifyAttention: true,
  channelReady: true,
  codeDelivery: true,
  memberSearch: true,
};

describe("IdentityLinkBlock unlink", () => {
  beforeEach(() => {
    unlinkMutate.mockReset();
    unlinkPending = false;
    unlinkError = null;
  });

  it("opens a confirm dialog and fires nothing on the click alone", () => {
    render(<IdentityLinkBlock link={LINKED} title="Slack" />);
    fireEvent.click(screen.getByRole("button", { name: "Unlink Slack" }));
    expect(screen.getByText("Unlink Slack?")).toBeTruthy();
    expect(unlinkMutate).not.toHaveBeenCalled();
  });

  it("fires the unlink mutation once the dialog is confirmed", () => {
    render(<IdentityLinkBlock link={LINKED} title="Slack" />);
    fireEvent.click(screen.getByRole("button", { name: "Unlink Slack" }));
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(unlinkMutate).toHaveBeenCalledWith(
      undefined,
      expect.objectContaining({ onSuccess: expect.any(Function) }),
    );
  });

  it("fires nothing when the dialog is cancelled", () => {
    render(<IdentityLinkBlock link={LINKED} title="Slack" />);
    fireEvent.click(screen.getByRole("button", { name: "Unlink Slack" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(unlinkMutate).not.toHaveBeenCalled();
    expect(screen.queryByText("Unlink Slack?")).toBeNull();
  });

  it("shows the server error in the dialog instead of swallowing it", () => {
    unlinkError = new ApiError(500, "Slack is unreachable. Try again in a minute.");
    render(<IdentityLinkBlock link={LINKED} title="Slack" />);
    fireEvent.click(screen.getByRole("button", { name: "Unlink Slack" }));
    expect(screen.getByText("Slack is unreachable. Try again in a minute.")).toBeTruthy();
  });

  it("shows pending state on the confirm button while the unlink runs", () => {
    const { rerender } = render(<IdentityLinkBlock link={LINKED} title="Slack" />);
    fireEvent.click(screen.getByRole("button", { name: "Unlink Slack" }));
    unlinkPending = true;
    rerender(<IdentityLinkBlock link={LINKED} title="Slack" />);
    expect(screen.getByRole("button", { name: "Unlinking…" })).toBeTruthy();
  });
});
