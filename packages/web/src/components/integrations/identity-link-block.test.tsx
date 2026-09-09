// @vitest-environment jsdom
/**
 * Unlinking deletes the pairing between the provider account and the Valet
 * account, so the confirm step has to be a real dialog: browser automation
 * auto-accepts `window.confirm`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import type { IdentityLinkStatus } from "@valet/api/wire";
import { ApiError } from "~/api/client";

const unlinkMutate = vi.fn();
let unlinkPending = false;
let unlinkError: Error | null = null;
// Clears like the real `reset()`: a bare `vi.fn()` keeps the error alive
// forever, which would hide every stale-error bug this file covers.
const unlinkReset = vi.fn(() => {
  unlinkError = null;
});

vi.mock("~/api/queries", () => ({
  useIdentityLinks: () => ({ data: { links: [] }, isLoading: false, error: null }),
  useStartIdentityLink: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useDeliverIdentityLink: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useLinkMembers: () => ({ data: undefined, isLoading: false, isError: false, error: null }),
  useUnlinkIdentity: () => ({
    mutate: unlinkMutate,
    isPending: unlinkPending,
    error: unlinkError,
    reset: unlinkReset,
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
    // mockClear, not mockReset: the clearing implementation is the point.
    unlinkReset.mockClear();
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
    const { rerender } = render(<IdentityLinkBlock link={LINKED} title="Slack" />);
    // Production order: the dialog opens clean, the user confirms, and the
    // refusal lands on the dialog that is already open.
    fireEvent.click(screen.getByRole("button", { name: "Unlink Slack" }));
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    unlinkError = new ApiError(500, "Slack is unreachable. Try again in a minute.");
    rerender(<IdentityLinkBlock link={LINKED} title="Slack" />);
    expect(screen.getByText("Slack is unreachable. Try again in a minute.")).toBeTruthy();
  });

  it("reopening after a refusal starts with no error", () => {
    const { rerender } = render(<IdentityLinkBlock link={LINKED} title="Slack" />);
    fireEvent.click(screen.getByRole("button", { name: "Unlink Slack" }));
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    unlinkError = new ApiError(500, "Slack is unreachable. Try again in a minute.");
    rerender(<IdentityLinkBlock link={LINKED} title="Slack" />);
    // Without this the "gone after reopen" assertion below could pass on an
    // error that never rendered at all.
    expect(screen.getByText("Slack is unreachable. Try again in a minute.")).toBeTruthy();

    // React Query holds the error until the next mutate, so the second visit
    // must clear it. A dialog that opens already refused reads as a fresh
    // failure the user never caused.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Unlink Slack" }));
    expect(screen.getByText("Unlink Slack?")).toBeTruthy();
    expect(screen.queryByText("Slack is unreachable. Try again in a minute.")).toBeNull();
  });

  it("shows pending state on the confirm button while the unlink runs", () => {
    const { rerender } = render(<IdentityLinkBlock link={LINKED} title="Slack" />);
    fireEvent.click(screen.getByRole("button", { name: "Unlink Slack" }));
    unlinkPending = true;
    rerender(<IdentityLinkBlock link={LINKED} title="Slack" />);
    expect(screen.getByRole("button", { name: "Unlinking…" })).toBeTruthy();
  });
});
