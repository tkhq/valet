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
// The thread picker reads the network; emit one fixed pick instead.
vi.mock("~/components/presence/thread-picker", () => ({
  ThreadPicker: ({ onPick }: { onPick: (p: { mode: "existing"; sessionId: string; threadId: string }, title: string) => void }) => (
    <button type="button" onClick={() => onPick({ mode: "existing", sessionId: "s1", threadId: "t1" }, "Deploys")}>Pick Deploys</button>
  ),
}));
const sub: EventSubscriptionWire = {
  id: "sub-1", name: "Replies", ownerType: "user", ownerId: "u1",
  eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "in", value: ["C1", "C2"], labels: ["#one", "#two"] }],
  target: { kind: "assistant", assistant: "user", follow: true }, enabled: true,
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
    fireEvent.click(screen.getByRole("checkbox", { name: "Someone posts a message" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Someone mentions Valet" }));
    expect(screen.getByDisplayValue("C1, C2")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Reaction happens" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Someone posts a message" }));
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


it("loads a workflow appearance override and clears it without rewriting the match", () => {
  edit({ ...sub, target: { kind: "workflow", workflowId: "wf_1", appearance: { displayName: "Release bot" } } });
  expect(screen.getByLabelText<HTMLInputElement>("Display name").value).toBe("Release bot");
  fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "" } });
  save();
  expect(patch.mock.calls[0][0]).toEqual({ id: "sub-1", body: { appearance: null } });
});

it("rejects an insecure avatar URL before sending a subscription edit", () => {
  edit();
  fireEvent.change(screen.getByLabelText("Avatar URL"), { target: { value: "http://example.com/avatar.png" } });
  save();
  expect(patch).not.toHaveBeenCalled();
  expect(screen.getAllByText(/Enter an HTTPS URL/).length).toBeGreaterThan(0);
});

describe("EditSubscriptionDialog Runs in", () => {
  it("shows the effective policy of a rule with none stored and sends nothing when unchanged", () => {
    const close = edit();
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "A new thread each time" }).checked).toBe(true);
    expect(screen.getByRole("radio", { name: "One thread per channel" })).toBeTruthy();
    save();
    expect(patch).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledWith(false);
  });

  it("submits a changed policy", () => {
    edit();
    fireEvent.click(screen.getByRole("radio", { name: "Its own thread" }));
    save();
    expect(patch.mock.calls[0][0]).toEqual({ id: "sub-1", body: { thread: { mode: "own" } } });
  });

  it("submits a picked existing thread and refuses a save before the pick", () => {
    edit();
    fireEvent.click(screen.getByRole("radio", { name: "An existing thread…" }));
    save();
    expect(patch).not.toHaveBeenCalled();
    expect(screen.getByText("Pick a thread for Runs in, or choose another option.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Pick Deploys" }));
    save();
    expect(patch.mock.calls[0][0]).toEqual({
      id: "sub-1", body: { thread: { mode: "existing", sessionId: "s1", threadId: "t1" } },
    });
  });

  it("reads a Slack message rule with no stored policy as a new thread, and an own pick as shared", () => {
    edit({ ...sub, eventKeys: ["slack.message"], target: { kind: "assistant", assistant: "user" } });
    expect(screen.getByRole<HTMLInputElement>("radio", { name: "A new thread each time" }).checked).toBe(true);
    fireEvent.click(screen.getByRole("radio", { name: "Its own thread" }));
    expect(screen.getByText("Messages from several Slack conversations will share this thread.")).toBeTruthy();
  });

  it("offers no Runs in on a workflow target", () => {
    edit({ ...sub, target: { kind: "workflow", workflowId: "wf_1" } });
    expect(screen.queryByRole("group", { name: "Runs in" })).toBeNull();
  });
});

describe("EditSubscriptionDialog in words", () => {
  const scoped: EventSubscriptionWire = {
    ...sub,
    filters: [
      { field: "channel", op: "in", value: ["C1", "C2"], labels: ["#one", "#two"] },
      { field: "user", op: "eq", value: "U0ABC" },
    ],
  };

  it("reads the draft as its sentence at the top, and updates with the form", () => {
    edit(scoped);
    const preview = screen.getByTestId("edit-preview");
    expect(preview.textContent).toBe("When you mention Valet in #one or #two, reply in a new thread.");
    fireEvent.click(screen.getByRole("checkbox", { name: "Someone posts a message" }));
    expect(preview.textContent).toBe("When you mention Valet or someone posts a message in #one or #two, reply in a new thread.");
  });

  it("hides the creator scope from the filters, shows it as a read-only line, and keeps it on save", () => {
    edit(scoped);
    expect(screen.getByTestId("creator-scope").textContent).toMatch(/^Only your own mentions/);
    expect(screen.queryByDisplayValue("U0ABC")).toBeNull();
    expect(screen.getAllByLabelText("Filter field")).toHaveLength(1);
    // Removing the other filter still works, and the scope stays.
    fireEvent.click(screen.getByRole("checkbox", { name: /Any channel/ }));
    fireEvent.click(screen.getByRole("button", { name: "Remove filter" }));
    save();
    expect(patch.mock.calls[0][0].body).toMatchObject({ anyChannel: true, filters: [{ field: "user", op: "eq", value: "U0ABC" }] });
  });

  it("names the creator when the viewer is someone else", () => {
    const close = vi.fn();
    render(
      <EditSubscriptionDialog
        open
        sub={{ ...scoped, target: { kind: "assistant", assistant: "org" }, createdBy: "u2" }}
        targetLabel="The organization's assistant"
        onOpenChange={close}
        names={{ me: "u1", members: { u2: "Jack" } }}
      />,
    );
    expect(screen.getByTestId("creator-scope").textContent).toMatch(/^Only mentions by Jack/);
    expect(screen.getByTestId("edit-preview").textContent).toBe("When Jack mentions Valet in #one or #two, reply in a new thread.");
  });

  it("shows When, Do, Runs in, and Appears as in words, never raw keys or filters", () => {
    edit(scoped);
    const summary = screen.getByLabelText("Summary");
    expect([...summary.querySelectorAll("dt")].map((dt) => dt.textContent)).toEqual(["When", "Do", "Runs in", "Appears as", "Delivery", "Permissions"]);
    expect(summary.textContent).not.toMatch(/slack\.|user eq|channel in|Scope|Destination/);
  });
});
