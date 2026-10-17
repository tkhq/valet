// @vitest-environment jsdom
/**
 * `DeliveryList` shows where each delivery landed (spec 2026-10-16:
 * delivery threads and claims, Part E step 2): the thread it reached, the
 * thread whose waiter claimed it, or the dead-letter text.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { EventDeliveryWire } from "@valet/api/wire";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params, ...rest }: { children: React.ReactNode; to?: string; params?: Record<string, string> }) => (
    <a href={Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to ?? "")} {...rest}>
      {children}
    </a>
  ),
}));

import { DeliveryList } from "./delivery-list";

const base = { subscriptionId: "sub_1", subscriptionName: "Incident mentions", attempts: 1, deliveredAt: null, lastError: null };

describe("DeliveryList", () => {
  it("links a delivered row to the thread it reached", () => {
    const delivered: EventDeliveryWire = {
      ...base, id: "d1", status: "delivered", deliveredAt: 1_723_200_000_000, thread: { sessionId: "sess_1", threadId: "th_inc" },
    };
    render(<DeliveryList deliveries={[delivered]} now={1_723_200_000_000} />);
    expect(screen.getByRole("link", { name: "Delivered to thread" }).getAttribute("href")).toBe("/threads/th_inc");
  });

  it("links a claimed row to the thread that claimed it, in place of the raw skip text", () => {
    const claimed: EventDeliveryWire = {
      ...base, id: "d2", status: "skipped", lastError: "Skipped, claimed by thread th_inc.", claimedBy: { sessionId: "sess_1", threadId: "th_inc" },
    };
    render(<DeliveryList deliveries={[claimed]} now={1_723_200_000_000} />);
    expect(screen.getByRole("link", { name: "Claimed by thread" }).getAttribute("href")).toBe("/threads/th_inc");
    expect(screen.queryByText("Skipped, claimed by thread th_inc.")).toBeNull();
  });

  it("shows the skip text when the viewer may not open the claiming thread", () => {
    const claimed: EventDeliveryWire = { ...base, id: "d3", status: "skipped", lastError: "Skipped, claimed by thread th_inc." };
    render(<DeliveryList deliveries={[claimed]} now={1_723_200_000_000} />);
    expect(screen.getByText("Skipped, claimed by thread th_inc.")).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("shows the dead-letter text of a stamped target that could not take the delivery", () => {
    const text = "The original conversation was archived or deleted. Restore it before retrying delivery.";
    const dead: EventDeliveryWire = { ...base, id: "d4", status: "dead", lastError: text };
    render(<DeliveryList deliveries={[dead]} now={1_723_200_000_000} />);
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
});
