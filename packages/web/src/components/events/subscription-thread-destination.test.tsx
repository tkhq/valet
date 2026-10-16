// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { SubscriptionThreadDestination } from "./subscription-thread-destination";
const change = vi.fn();
const refetch = vi.fn();
const query = { data: { pages: [{ threads: [{ id: "t1", sessionId: "s1", title: "Incident triage" }] }] }, isPending: false, isError: false, hasNextPage: false, refetch };
vi.mock("~/api/events", () => ({ useEventSubscriptionThreads: () => query }));
beforeEach(() => { query.isError = false; query.isPending = false; change.mockReset(); refetch.mockReset(); });
it("preserves automatic routing until the user chooses a destination", () => {
  render(<SubscriptionThreadDestination owner={{ ownerType: "user", ownerId: "u1" }} value={null} onChange={change} />);
  expect(change).not.toHaveBeenCalled();
  fireEvent.change(screen.getByLabelText("Run in"), { target: { value: "new" } });
  expect(change).toHaveBeenCalledWith({ mode: "new" });
});
it("selects the exact session and thread from eligible results", () => {
  render(<SubscriptionThreadDestination owner={{ ownerType: "team", ownerId: "team1" }} value={null} onChange={change} />);
  fireEvent.change(screen.getByLabelText("Run in"), { target: { value: "existing" } });
  fireEvent.click(screen.getByRole("button", { name: "Incident triage" }));
  expect(change).toHaveBeenLastCalledWith({ mode: "existing", sessionId: "s1", threadId: "t1" });
});
it("hides stale results on error and offers retry", () => {
  query.isError = true;
  render(<SubscriptionThreadDestination owner={{ ownerType: "user", ownerId: "u1" }} value={{ mode: "existing", sessionId: "s1", threadId: "t1" }} onChange={change} />);
  expect(screen.queryByRole("button", { name: "Incident triage" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(refetch).toHaveBeenCalled();
});
