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

  it("names no thread when the viewer may not open the claiming thread", () => {
    const claimed: EventDeliveryWire = { ...base, id: "d3", status: "skipped", lastError: "Skipped, claimed by thread th_inc." };
    render(<DeliveryList deliveries={[claimed]} now={1_723_200_000_000} />);
    expect(screen.getByText("Skipped, claimed by another thread.")).toBeTruthy();
    expect(screen.queryByText(/th_inc/)).toBeNull();
    // The only link is the line's own page.
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["Incident mentions"]);
  });

  it("names the thread by the title its ref carries", () => {
    const delivered: EventDeliveryWire = { ...base, id: "d5", status: "delivered", thread: { sessionId: "sess_1", threadId: "th_inc", title: "Incident 42" } };
    const claimed: EventDeliveryWire = { ...base, id: "d6", status: "skipped", claimedBy: { sessionId: "sess_1", threadId: "th_ci", title: " " } };
    render(<DeliveryList deliveries={[delivered, claimed]} now={0} />);
    expect(screen.getByRole("link", { name: "Delivered to Incident 42" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Claimed by thread" })).toBeTruthy();
  });

  it("leads a listener's row with its event, linked to the event page", () => {
    const event = { id: "ev_1", service: "github", eventKey: "github.check_run.completed", summary: "CI failed", refs: {}, actor: null, occurredAt: 1, receivedAt: 1 };
    render(<DeliveryList deliveries={[{ ...base, id: "d7", status: "pending", event }]} empty="No deliveries yet." now={0} />);
    expect(screen.getByRole("link", { name: "CI failed" }).getAttribute("href")).toBe("/presence/events/ev_1");
    expect(screen.queryByText("Incident mentions")).toBeNull();
  });

  it("shows the caller's empty text", () => {
    render(<DeliveryList deliveries={[]} empty="No deliveries yet." />);
    expect(screen.getByText("No deliveries yet.")).toBeTruthy();
  });

  it("shows the dead-letter text of a pin that cannot take the delivery", () => {
    const text = "Pick another thread in Presence.";
    const dead: EventDeliveryWire = { ...base, id: "d4", status: "dead", lastError: text };
    render(<DeliveryList deliveries={[dead]} now={1_723_200_000_000} />);
    expect(screen.getByText(text)).toBeTruthy();
    expect(screen.getAllByRole("link").map((link) => link.textContent)).toEqual(["Incident mentions"]);
  });

  it("links the line's name to the line's page on one event's list", () => {
    const delivered: EventDeliveryWire = { ...base, id: "d8", status: "delivered" };
    render(<DeliveryList deliveries={[delivered]} now={0} />);
    expect(screen.getByRole("link", { name: "Incident mentions" }).getAttribute("href")).toBe("/presence/rules/sub_1");
  });
});
