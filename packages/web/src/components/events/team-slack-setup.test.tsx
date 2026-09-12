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
vi.mock("~/api/events", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/api/events")>(),
  useEventSubscriptions: (owner: { ownerId: string }) => {
    expect(owner).toEqual({ ownerType: "team", ownerId: "a" });
    return {
      data: {
        subscriptions: state.existing
          ? [
              {
                id: "existing",
                name: "Alpha replies",
                enabled: false,
                ownerType: "team",
                ownerId: "a",
                eventKeys: ["slack.app_mention"],
                target: {
                  kind: "orchestrator",
                  orchestrator: "team",
                  teamId: "a",
                },
              },
            ]
          : [],
      },
    };
  },
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
  fireEvent.click(screen.getByRole("button", { name: "Set up Slack replies" }));
}
describe("team homepage Slack setup", () => {
  it("opens the existing reply flow for a team member", () => {
    open();
    expect(screen.getByRole("dialog").textContent).toBe(
      "Reply setup for Alpha (a)",
    );
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
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("button", { name: "Set up Slack replies" })));
  });

  it("shows existing disabled rules before offering another", () => {
    state.existing = true;
    open();
    expect(screen.getByText("Alpha replies (disabled)")).toBeTruthy();
    expect(screen.queryByText(/Reply setup for/)).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Add another reply rule" }),
    );
    expect(screen.getByText(/Reply setup for Alpha/)).toBeTruthy();
  });
  it.each(["failed", "loading", "member"] as const)(
    "holds setup when %s is unresolved or refused",
    (field) => {
      state[field] = field !== "member";
      open();
      expect(screen.queryByText(/Reply setup for/)).toBeNull();
      expect(
        screen.getByRole(field === "loading" ? "status" : "alert"),
      ).toBeTruthy();
    },
  );
});
