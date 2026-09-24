// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const useEventsMock = vi.fn();
vi.mock("~/api/events", () => ({ useEvents: (...args: unknown[]) => useEventsMock(...args) }));
vi.mock("./event-row", () => ({
  EventRow: ({ event, onToggle }: { event: { summary: string }; onToggle: () => void }) => (
    <button type="button" onClick={onToggle}>{event.summary}</button>
  ),
}));

import { DropsPanel } from "./drops-panel";

const event = {
  id: "e1",
  service: "slack",
  eventKey: "slack.block_actions",
  summary: "Form submitted",
  refs: {},
  actor: null,
  occurredAt: 1,
  receivedAt: 1,
};

describe("DropsPanel", () => {
  it("lists Slack webhook events and refreshes them", () => {
    const refetch = vi.fn();
    useEventsMock.mockReturnValue({ isPending: false, isFetching: false, error: null, data: { events: [event] }, refetch });
    render(<DropsPanel />);

    expect(useEventsMock).toHaveBeenCalledWith({ service: "slack" });
    expect(screen.getByText("Form submitted")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Refresh Slack webhook events" }));
    expect(refetch).toHaveBeenCalledOnce();
  });

  it("shows useful loading, empty, and failure states", () => {
    useEventsMock.mockReturnValue({ isPending: true, isFetching: false, error: null, data: undefined, refetch: vi.fn() });
    const { rerender } = render(<DropsPanel />);
    expect(screen.getByText(/Loading Slack webhook events/)).toBeTruthy();

    useEventsMock.mockReturnValue({ isPending: false, isFetching: false, error: null, data: { events: [] }, refetch: vi.fn() });
    rerender(<DropsPanel />);
    expect(screen.getByText(/No Slack webhook events are recorded/)).toBeTruthy();

    useEventsMock.mockReturnValue({ isPending: false, isFetching: false, error: new Error("forbidden"), data: undefined, refetch: vi.fn() });
    rerender(<DropsPanel />);
    expect(screen.getByText(/Confirm that you are an organization admin/)).toBeTruthy();
  });
});
