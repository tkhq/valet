// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const useEventDropsMock = vi.fn();
vi.mock("~/api/events", () => ({ useEventDrops: () => useEventDropsMock() }));

import { DropsPanel } from "./drops-panel";

describe("DropsPanel", () => {
  it("renders drops with human reason labels, details, and the last-received line", () => {
    const now = Date.now();
    useEventDropsMock.mockReturnValue({
      isPending: false,
      error: null,
      data: {
        lastEventAt: now - 60_000,
        drops: [
          {
            id: "d1",
            reason: "no_subscription_match",
            detail: "A slack.reaction_added event arrived, but no enabled subscription names it.",
            createdAt: now - 30_000,
          },
          { id: "d2", reason: "bad_signature", detail: "signature verification failed", createdAt: now - 120_000 },
          { id: "d3", reason: "slack_interaction_unmatched", detail: "A Slack block_actions interaction arrived.", createdAt: now - 90_000 },
        ],
      },
    });
    render(<DropsPanel />);
    expect(screen.getByText("No subscription")).toBeTruthy();
    expect(screen.getByText("Bad signature")).toBeTruthy();
    expect(screen.getByText("Slack form did not start a workflow")).toBeTruthy();
    expect(screen.queryByText(/no enabled subscription names it/)).toBeNull();
    const details = screen.getAllByRole("button", { name: "Details" })[0];
    expect(details.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(details);
    expect(details.getAttribute("aria-expanded")).toBe("true");
    expect(details.getAttribute("aria-controls")).toBeTruthy();
    expect(screen.getByText(/no enabled subscription names it/)).toBeTruthy();
    fireEvent.click(details);
    expect(screen.queryByText(/no enabled subscription names it/)).toBeNull();
    expect(screen.getByText(/Last event received/)).toBeTruthy();
  });

  it("tells the user when no event has ever arrived", () => {
    useEventDropsMock.mockReturnValue({ isPending: false, error: null, data: { lastEventAt: null, drops: [] } });
    render(<DropsPanel />);
    expect(screen.getByText(/No event has reached Valet yet/)).toBeTruthy();
    expect(screen.getByText(/No problems in the recent window/)).toBeTruthy();
  });

  it("shows a loading state", () => {
    useEventDropsMock.mockReturnValue({ isPending: true, error: null, data: undefined });
    render(<DropsPanel />);
    expect(screen.getByText(/Loading problems/)).toBeTruthy();
  });
});
