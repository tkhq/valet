// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const useEventDropsMock = vi.fn();
vi.mock("~/api/events", () => ({ useEventDrops: (...args: unknown[]) => useEventDropsMock(...args) }));

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

  it("limits searches to 200 characters before it submits them", async () => {
    useEventDropsMock.mockReturnValue({ isPending: false, error: null, data: { lastEventAt: null, drops: [] } });
    const onQueryChange = vi.fn();
    const user = userEvent.setup();
    render(<DropsPanel onQueryChange={onQueryChange} />);

    const search = screen.getByRole("searchbox", { name: "Search problems" }) as HTMLInputElement;
    await user.type(search, "x".repeat(201));

    expect(search.value).toBe("x".repeat(200));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(onQueryChange).toHaveBeenCalledWith("x".repeat(200));
  });

  it("explains how to correct an overlong search from a URL", () => {
    useEventDropsMock.mockReturnValue({ isPending: false, error: null, data: undefined });
    const query = "x".repeat(201);
    render(<DropsPanel query={query} />);

    expect(screen.getByRole("alert").textContent).toBe(
      "Search is too long. Shorten the search to 200 characters or fewer.",
    );
    expect(useEventDropsMock).toHaveBeenLastCalledWith(
      { q: query, cursor: undefined, direction: undefined },
      { enabled: false },
    );
  });
});
