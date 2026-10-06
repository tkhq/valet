// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ApiError } from "~/api/client";
import type { EventSubscriptionWire } from "@valet/api/wire";
import { EditSubscriptionDialog } from "./edit-subscription-dialog";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));
const patch = vi.fn();
vi.mock("~/api/events", () => ({
  useEventCatalog: () => ({ data: { services: [{ service: "slack", entries: [
    { key: "slack.app_mention", description: "Mention", filters: [{ field: "channel" }] },
    { key: "slack.message", description: "Message", filters: [{ field: "channel" }] },
    { key: "slack.reaction", description: "Reaction", filters: [{ field: "reaction" }] },
  ] }] }, isLoading: false, error: null }),
  usePatchEventSubscription: () => ({ mutate: patch, isPending: false }),
}));
const sub: EventSubscriptionWire = {
  id: "sub-1", name: "Replies", ownerType: "user", ownerId: "u1",
  eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "in", value: ["C1", "C2"], labels: ["#one", "#two"] }],
  target: { kind: "orchestrator", orchestrator: "user", follow: true }, enabled: true,
  createdBy: "u1", createdAt: 1, updatedAt: 1,
};
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save" }));
function edit(value = sub) {
  const close = vi.fn();
  render(<EditSubscriptionDialog open sub={value} targetLabel="Personal assistant" onOpenChange={close} />);
  return close;
}
beforeEach(() => patch.mockReset());

describe("EditSubscriptionDialog match form", () => {
  it("closes an unchanged multi-channel rule and sends only a changed name", () => {
    const close = edit();
    save();
    expect(close).toHaveBeenCalledWith(false);
    expect(patch).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Renamed" } });
    save();
    expect(patch.mock.calls[0][0]).toEqual({ id: "sub-1", body: { name: "Renamed" } });
  });

  it("keeps shared fields and prunes orphaned filters on event deselection", () => {
    edit();
    fireEvent.click(screen.getByRole("checkbox", { name: /slack\.message/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /slack\.app_mention/ }));
    expect(screen.getByDisplayValue("C1, C2")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /slack\.reaction/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /slack\.message/ }));
    expect(screen.queryByLabelText("Filter value")).toBeNull();
    save();
    expect(patch.mock.calls[0][0]).toEqual({ id: "sub-1", body: { eventKeys: ["slack.reaction"], filters: [] } });
  });

  it("requires fixed channel scope unless Any channel is selected", () => {
    edit();
    fireEvent.change(screen.getByLabelText("Filter operator"), { target: { value: "contains" } });
    save();
    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByText(/A mention rule needs a channel filter/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Any channel/ }));
    save();
    expect(patch.mock.calls[0][0].body).toMatchObject({ anyChannel: true, filters: [{ field: "channel", op: "contains", value: "C1, C2" }] });
  });

  it("rejects contradictory channel scope and incomplete rows", () => {
    edit();
    fireEvent.click(screen.getByRole("checkbox", { name: /Any channel/ }));
    save();
    expect(screen.getByText(/removes the channel restriction/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: " , " } });
    save();
    expect(screen.getByText(/Enter a value for/)).toBeTruthy();
    expect(patch).not.toHaveBeenCalled();
  });

  it("preserves stored any-channel state until the user selects fixed channels", () => {
    edit({ ...sub, filters: [] });
    fireEvent.click(screen.getByText(/^Add filter$/));
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "C3" } });
    save();
    expect(patch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("checkbox", { name: /Any channel/ }));
    save();
    expect(patch.mock.calls[0][0]).toEqual({ id: "sub-1", body: { filters: [{ field: "channel", op: "eq", value: "C3" }] } });
  });

  it("retries a refused edit with allowCollision and waits for Done after a committed overlap", () => {
    const report = { blocking: [{ subscription: sub, relation: "superset", sharedKeys: sub.eventKeys }], overlapping: [] };
    patch.mockImplementationOnce((_body: unknown, handlers: { onError: (error: Error) => void }) => {
      handlers.onError(new ApiError(409, "collision", { collisions: report }));
    });
    patch.mockImplementationOnce((_body: unknown, handlers: { onSuccess: (response: unknown) => void }) => {
      handlers.onSuccess({ collisions: { blocking: [], overlapping: report.blocking } });
    });
    const close = edit();
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "C3, C4" } });
    save();
    expect(close).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Save anyway" }));
    expect(patch).toHaveBeenCalledTimes(2);
    expect(patch.mock.calls[1][0]).toEqual({ id: "sub-1", body: {
      filters: [{ field: "channel", op: "in", value: ["C3", "C4"] }], allowCollision: true,
    } });
    expect(close).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(close).toHaveBeenCalledWith(false);
  });

});
