// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EventSubscriptionWire } from "@valet/api/wire";
import type { ReactNode } from "react";

const state = vi.hoisted(() => ({
  connected: true,
  member: true,
  failed: false,
  loading: false,
  existing: false,
  patterns: [] as EventSubscriptionWire[],
  orgAdmin: true,
}));
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, children }: { to: string; children: ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));
vi.mock("~/api/settings", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/settings")>(),
  useMe: () => ({ data: { orgRole: state.orgAdmin ? "admin" : "member" } }),
  useTeams: () => ({
    data: {
      teams: [
        { id: "a", name: "Alpha", callerRole: state.member ? "member" : null },
        { id: "b", name: "Design", callerRole: null },
      ],
    },
  }),
}));
vi.mock("~/api/integrations", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/integrations")>(),
  usePlugins: () => ({
    data: state.loading
      ? undefined
      : {
          plugins: [
            {
              services: [
                {
                  service: "slack",
                  connect: state.connected ? "org" : "unconfigured",
                },
              ],
            },
          ],
        },
    error: state.failed ? new Error("offline") : null,
  }),
}));
const createMutate = vi.fn();
const patchMutate = vi.fn();
const deleteMutate = vi.fn();
function mentionRule(id: string, ownerId: string, channel: string, enabled = true) {
  return {
    id, name: `${ownerId} replies`, enabled, ownerType: "team", ownerId, createdBy: "u", createdAt: 1, updatedAt: 1,
    eventKeys: ["slack.app_mention"], filters: [{ field: "channel", op: "eq", value: channel, label: channel === "C1" ? "#general" : "#design" }],
    target: { kind: "assistant", assistant: "team", teamId: ownerId },
  };
}
vi.mock("~/api/events", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/events")>(),
  useEventSubscriptions: () => ({
    data: { subscriptions: [...(state.existing ? [mentionRule("mine", "a", "C1"), mentionRule("theirs", "b", "C2")] : []), ...state.patterns] },
  }),
  useFilterOptions: () => ({
    isPending: false,
    data: { options: [{ id: "C1", label: "#general" }, { id: "C2", label: "#design" }, { id: "C3", label: "#launch" }] },
  }),
  useCreateEventSubscription: () => ({ mutate: createMutate, isPending: false, error: null }),
  usePatchEventSubscription: () => ({ mutate: patchMutate, isPending: false, error: null }),
  useDeleteEventSubscription: () => ({ mutate: deleteMutate, isPending: false, error: null }),
}));
vi.mock("~/components/presence/editor/line-editor", async () => (await import("~/components/presence/editor/test-editor-stub")).stubModule);
import { ListenButton, TeamSlackSetupCard } from "./team-slack-setup";

beforeEach(() =>
  Object.assign(state, {
    connected: true,
    member: true,
    failed: false,
    loading: false,
    existing: false,
    patterns: [],
    orgAdmin: true,
  }),
);
function open() {
  if (state.existing) render(<ListenButton teamId="a">Listen in channels</ListenButton>);
  else render(<TeamSlackSetupCard teamId="a" />);
  fireEvent.click(screen.getByRole("button", { name: state.existing ? "Listen in channels" : "Choose channels" }));
}
describe("team homepage Slack setup", () => {
  it("shows name-pattern rules alongside exact channels and opens each for editing", () => {
    state.existing = true;
    state.patterns = [{
      id: "lead-rule", name: "Lead replies", enabled: true, ownerType: "team", ownerId: "a", createdBy: "u", createdAt: 1, updatedAt: 1,
      eventKeys: ["slack.app_mention"], filters: [{ field: "channel_name", op: "prefix", value: "lead-" }],
      target: { kind: "assistant", assistant: "team", teamId: "a", follow: true },
    }];
    open();
    expect(screen.getByText(/channel name starts with lead-/i)).toBeTruthy();
    expect(screen.getByText(/Separate rules match alternative channels/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit Lead replies" }));
    expect(screen.getByTestId("line-editor").textContent).toContain("edit Lead replies");
  });

  it("offers a separate channel-name response rule", () => {
    state.existing = true;
    open();
    fireEvent.click(screen.getByRole("button", { name: "Add channel-name rule" }));
    fireEvent.change(screen.getByLabelText("Channel name prefix"), { target: { value: "lead-" } });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(screen.getByTestId("line-editor").textContent).toContain("create team Alpha (a)");
  });

  it("hides the homepage prompt once the team listens, and adds channels to its one rule", () => {
    state.existing = true;
    patchMutate.mockClear(); createMutate.mockClear();
    // Once the team listens, the homepage prompt steps aside for the Events page.
    const card = render(<TeamSlackSetupCard teamId="a" />);
    expect(card.container.textContent).toBe("");
    card.unmount();
    open();
    expect(screen.getByRole("dialog", { name: "Where should Valet listen?" })).toBeTruthy();
    const general = screen.getByRole("checkbox", { name: /general/ });
    expect(general).toHaveProperty("checked", true);
    expect(general).toHaveProperty("disabled", false);
    expect(screen.getByRole("checkbox", { name: /design/ })).toHaveProperty("disabled", true);
    expect(screen.getByText("Taken by Design's Valet")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /launch/ }));
    fireEvent.click(screen.getByRole("button", { name: "Listen in 2 channels" }));
    expect(createMutate).not.toHaveBeenCalled();
    expect(patchMutate).toHaveBeenCalledWith({ id: "mine", body: { filters: [
      { field: "channel", op: "in", value: ["C1", "C3"], labels: ["#general", "#launch"] },
    ] } }, expect.anything());
  });
  it("stops listening when every channel is unchecked", () => {
    state.existing = true;
    deleteMutate.mockClear();
    open();
    fireEvent.click(screen.getByRole("checkbox", { name: /general/ }));
    fireEvent.click(screen.getByRole("button", { name: "Stop listening" }));
    expect(deleteMutate).toHaveBeenCalledWith("mine", expect.anything());
  });
  it("creates the team's rule for its first channels", () => {
    createMutate.mockClear();
    open();
    fireEvent.click(screen.getByRole("checkbox", { name: /launch/ }));
    fireEvent.click(screen.getByRole("button", { name: "Listen in 1 channel" }));
    expect(createMutate).toHaveBeenCalledWith(expect.objectContaining({
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C3", label: "#launch" }],
      target: { kind: "assistant", assistant: "team", teamId: "a", follow: true },
    }), expect.anything());
  });
  it("keeps the full reply setup behind Advanced setup", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Advanced setup" }));
    expect(screen.getByTestId("line-editor").textContent).toBe("Editor: create team Alpha (a)");
  });
  it("links missing bot setup to organization Slack settings", () => {
    state.connected = false;
    open();
    expect(
      screen
        .getByRole("link", { name: "Organization Settings → Slack" })
        .getAttribute("href"),
    ).toBe("/settings/organization/slack");
    expect(screen.queryByTestId("line-editor")).toBeNull();
  });
  it("does not send a non-admin into restricted organization settings", () => {
    state.connected = false;
    state.orgAdmin = false;
    open();
    expect(screen.getByText(/Ask an organization admin/)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });
  it("returns focus to the homepage button when closed", async () => {
    state.connected = false;
    open();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Choose channels" })));
  });

  it.each(["failed", "loading", "member"] as const)(
    "holds setup when %s is unresolved or refused",
    (field) => {
      state[field] = field !== "member";
      open();
      expect(screen.queryByRole("list", { name: "Slack channels" })).toBeNull();
      expect(
        screen.getByRole(field === "loading" ? "status" : "alert"),
      ).toBeTruthy();
    },
  );
});
