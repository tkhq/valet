// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { EventSubscriptionWire } from "@valet/api/wire";
import { SubscriptionDetailPage } from "./events.subscriptions.$subscriptionId";
const subscription: EventSubscriptionWire = { id: "sub1", name: "Release alerts", ownerType: "user", ownerId: "u1", eventKeys: ["github.pr.opened"], filters: [], target: { kind: "orchestrator" }, enabled: true, createdBy: "u1", createdAt: 1, updatedAt: 1 };
const state = { data: { subscription }, isPending: false, error: null as Error | null };
const patch = vi.fn();
const retry = vi.fn();
let viewerId = "u1";
vi.mock("@tanstack/react-router", () => ({ createFileRoute: () => (config: unknown) => config, useNavigate: () => vi.fn(), Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a> }));
vi.mock("~/api/events", () => ({
  useEventSubscription: () => ({ ...state, refetch: retry }),
  useEventSubscriptions: () => ({ data: { subscriptions: [subscription] } }),
  useEventCatalog: () => ({ data: { services: [] } }),
  usePatchEventSubscription: () => ({ mutate: patch, isPending: false }),
}));
vi.mock("~/api/settings", () => ({ useMe: () => ({ data: { id: viewerId } }), useTeams: () => ({ data: { teams: [] } }), useOrg: () => ({ data: { features: {} } }) }));
vi.mock("~/api/workflows", () => ({ useWorkflows: () => ({ data: { workflows: [] } }) }));
vi.mock("~/lib/workspace-scope", () => ({ useAdoptWorkspaceScope: () => {} }));
vi.mock("~/components/events/subscription-thread-destination", () => ({ SubscriptionThreadDestination: () => <div>Run in</div> }));
vi.mock("~/components/events/event-match-step", () => ({ EventMatchStep: () => <div>Event match</div> }));
beforeEach(() => { state.error = null; state.isPending = false; viewerId = "u1"; patch.mockReset(); retry.mockReset(); });
it("edits inline at its own address and saves only changed fields", () => {
  render(<SubscriptionDetailPage subscriptionId="sub1" />);
  expect(screen.getByRole("heading", { name: "Release alerts" })).toBeTruthy();
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Release checks" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(patch.mock.calls[0][0]).toEqual({ id: "sub1", body: { name: "Release checks" } });
});
it("shows an error with retry rather than an editable stale form", () => {
  state.error = new Error("Not found");
  render(<SubscriptionDetailPage subscriptionId="sub1" />);
  expect(screen.queryByLabelText("Name")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalled();
});
it("keeps colleague subscriptions read only", () => {
  viewerId = "u2";
  render(<SubscriptionDetailPage subscriptionId="sub1" />);
  expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  expect(screen.getByText(/Only the owner/)).toBeTruthy();
});
