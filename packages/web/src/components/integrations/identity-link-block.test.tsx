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

const deliverMutateAsync = vi.fn();
const verifyMutate = vi.fn();
let verifyError: Error | null = null;

vi.mock("~/api/queries", () => ({
  useIdentityLinks: () => ({ data: { links: [] }, isLoading: false, error: null }),
  useStartIdentityLink: () => ({ mutateAsync: vi.fn(), isPending: false, error: null }),
  useDeliverIdentityLink: () => ({ mutateAsync: deliverMutateAsync, isPending: false, error: null }),
  useVerifyIdentityLink: () => ({ mutate: verifyMutate, isPending: false, error: verifyError }),
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

describe("IdentityLinkBlock sign-in with OAuth", () => {
  const UNLINKED: IdentityLinkStatus = {
    provider: "slack", linked: false, channelReady: true, codeDelivery: true, memberSearch: true, oauthService: "slack-user",
  };

  it("offers Sign in with Slack only when the page opts in", () => {
    const { rerender } = render(<IdentityLinkBlock link={UNLINKED} title="Slack" />);
    expect(screen.queryByRole("button", { name: "Sign in with Slack" })).toBeNull();
    rerender(<IdentityLinkBlock link={UNLINKED} title="Slack" offerOAuth />);
    expect(screen.getByRole("button", { name: "Sign in with Slack" })).toBeTruthy();
    // The button grants more than a link; the card says so.
    expect(screen.getByText(/search, read, and post in Slack as you/)).toBeTruthy();
  });

  it("starts the OAuth connect for the declared service", () => {
    Object.defineProperty(window, "location", { value: { ...window.location, href: "" }, writable: true });
    render(<IdentityLinkBlock link={UNLINKED} title="Slack" offerOAuth />);
    fireEvent.click(screen.getByRole("button", { name: "Sign in with Slack" }));
    expect(window.location.href).toBe("/api/credentials/slack-user/connect?landing=connected-accounts");
  });

  it("hides the button when the deployment has no OAuth client", () => {
    render(<IdentityLinkBlock link={{ ...UNLINKED, oauthService: undefined }} title="Slack" offerOAuth />);
    expect(screen.queryByRole("button", { name: "Sign in with Slack" })).toBeNull();
  });
});

// v1's flow: the bot DMs a code, and the person types it into Valet.
describe("IdentityLinkBlock DM me", () => {
  const UNLINKED: IdentityLinkStatus = {
    provider: "slack", linked: false, channelReady: true, codeDelivery: true, memberSearch: true,
  };

  beforeEach(() => {
    verifyMutate.mockReset();
    verifyError = null;
    deliverMutateAsync.mockResolvedValue({
      delivered: true, externalId: "U777", displayName: "ada", expiresInSeconds: 600,
    });
  });

  it("asks for the DMed code and submits it to verify", async () => {
    render(<IdentityLinkBlock link={UNLINKED} title="Slack" />);
    fireEvent.click(screen.getByRole("button", { name: "DM me on Slack" }));

    const input = await screen.findByRole("textbox", { name: "Slack link code" });
    expect(screen.getByText(/We DMed/).textContent).toContain("@ada");
    fireEvent.change(input, { target: { value: "  Ab3_dE-9fGh1jK2lMn4pQr " } });
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(verifyMutate).toHaveBeenCalledWith({ provider: "slack", code: "Ab3_dE-9fGh1jK2lMn4pQr" });
  });

  it("shows the server's refusal for a wrong code", async () => {
    verifyError = new ApiError(400, "POST /me/identity-links/slack/verify → 400", {
      error: "That code is invalid or expired. Send yourself a new DM from this card.",
    });
    render(<IdentityLinkBlock link={UNLINKED} title="Slack" />);
    fireEvent.click(screen.getByRole("button", { name: "DM me on Slack" }));
    expect(await screen.findByText(/invalid or expired/)).toBeTruthy();
  });
});
