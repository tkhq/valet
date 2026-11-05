// @vitest-environment jsdom
/**
 * One Activity row (docs/specs/2026-10-16-presence-hub-design.md Part E
 * step 1): each delivery reads as one outcome, keyed by its delivery, so
 * two lines with the same outcome words both show.
 */
import { cleanup, render, screen } from "@testing-library/react";
import type { EventDeliveryWire, EventLogItem } from "@valet/api/wire";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params, className }: { children: ReactNode; to: string; params?: Record<string, string>; className?: string }) => (
    <a className={className} href={Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)}>{children}</a>
  ),
}));
vi.mock("~/api/events", () => ({ useEventSubscriptions: () => ({ data: { subscriptions: [] } }) }));
vi.mock("~/api/workflows", () => ({ useWorkflows: () => ({ data: { workflows: [] } }) }));
vi.mock("~/lib/use-list-owner", () => ({ useListOwner: () => ({ ownerType: "user", ownerId: "u1" }) }));

import { ActivityRow } from "./activity-row";

afterEach(cleanup);

function delivery(id: string, over: Partial<EventDeliveryWire> = {}): EventDeliveryWire {
  return { id, subscriptionId: `sub-${id}`, status: "delivered", attempts: 1, lastError: null, deliveredAt: 1, ...over };
}

function item(deliveries: EventDeliveryWire[]): EventLogItem {
  return {
    kind: "event", id: "ev-1", at: 1, status: "delivered", service: "github", eventKey: "github.check_run.completed",
    summary: "s", actor: null, reason: null, detail: null, deliveryCount: deliveries.length, place: "acme/api",
    placeKey: "github:acme/api", deliveries,
  };
}

describe("ActivityRow", () => {
  it("shows two deliveries with the same outcome words, with no duplicate key", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const thread = { sessionId: "s", threadId: "t-ci", title: "Platform CI" };
    render(<ActivityRow item={item([delivery("d-1", { thread }), delivery("d-2", { thread }), delivery("d-3"), delivery("d-4")])} workflowsByListener={{}} />);
    expect(screen.getAllByRole("link", { name: "Platform CI" })).toHaveLength(2);
    const lead = screen.getByRole("link", { name: "Completed check in acme/api" });
    expect(lead.parentElement?.textContent).toBe(
      "Completed check in acme/api → delivered to Platform CI, delivered to Platform CI, delivered, delivered",
    );
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/same key/);
    errors.mockRestore();
  });
});
