// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

const state = vi.hoisted(() => ({
  connected: true,
  member: true,
  failed: false,
  loading: false,
  existing: false,
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
    target: { kind: "orchestrator", orchestrator: "team", teamId: ownerId },
  };
}
vi.mock("~/api/events", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/events")>(),
  useEventSubscriptions: () => ({
    data: { subscriptions: state.existing ? [mentionRule("mine", "a", "C1"), mentionRule("theirs", "b", "C2")] : [] },
  }),
  useFilterOptions: () => ({
    isPending: false,
    data: { options: [{ id: "C1", label: "#general" }, { id: "C2", label: "#design" }, { id: "C3", label: "#launch" }] },
  }),
  useCreateEventSubscription: () => ({ mutate: createMutate, isPending: false, error: null }),
  usePatchEventSubscription: () => ({ mutate: patchMutate, isPending: false, error: null }),
  useDeleteEventSubscription: () => ({ mutate: deleteMutate, isPending: false, error: null }),
}));
vi.mock("./automation-wizard", () => ({
  AutomationWizard: ({
    replyTeam,
  }: {
    replyTeam: { id: string; name: string };
  }) => (
    <div role="dialog">
      Reply setup for {replyTeam.name} ({replyTeam.id})
    </div>
  ),
}));
import { TeamSlackSetupCard } from "./team-slack-setup";

beforeEach(() =>
  Object.assign(state, {
    connected: true,
    member: true,
    failed: false,
    loading: false,
    existing: false,
    orgAdmin: true,
  }),
);
function open() {
  render(<TeamSlackSetupCard teamId="a" />);
  fireEvent.click(screen.getByRole("button", { name: state.existing ? "Edit channels" : "Choose channels" }));
}
describe("team homepage Slack setup", () => {
  it("shows where the team listens, and adds channels to its one rule", () => {
    state.existing = true;
    patchMutate.mockClear(); createMutate.mockClear();
    render(<TeamSlackSetupCard teamId="a" />);
    expect(screen.getByRole("heading", { name: "Valet is listening" })).toBeTruthy();
    expect(screen.getByText(/In #general\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Edit channels" }));
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
      target: { kind: "orchestrator", orchestrator: "team", teamId: "a", follow: true },
    }), expect.anything());
  });
  it("keeps the full reply setup behind Advanced setup", () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "Advanced setup" }));
    expect(screen.getByRole("dialog").textContent).toBe("Reply setup for Alpha (a)");
  });
  it("links missing bot setup to organization Slack settings", () => {
    state.connected = false;
    open();
    expect(
      screen
        .getByRole("link", { name: "Organization Settings → Slack" })
        .getAttribute("href"),
    ).toBe("/settings/organization/slack");
    expect(screen.queryByText(/Reply setup for/)).toBeNull();
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
