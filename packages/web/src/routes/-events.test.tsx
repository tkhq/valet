// @vitest-environment jsdom
/**
 * `/events` — the events page: the Activity feed renders ingested events
 * and expands one into deliveries + payload; the Subscriptions tab lists
 * rules with a resolved workflow-target name, toggles `enabled` through
 * the patch mutation, and creates a subscription from catalog-picked keys.
 * Mocks `~/api/events`, `~/api/workflows`, and `~/api/settings` the same
 * way `-workflows.index.test.tsx` mocks its api module — this suite cares
 * that the page renders from query data and calls the right mutation.
 * `useMe` resolves to user "u1", the owner of the one fixture subscription,
 * so mutate controls render by default; one test flips ownership to prove
 * they gate on it.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { EventSubscriptionWire, TeamSummary } from "@valet/api/wire";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "~/components/primitives";

vi.mock("~/components/layout/workspace-assistant", () => ({ useWorkspaceAssistant: () => ({ open: vi.fn() }) }));

const catalogData = {
  services: [
    {
      service: "github",
      entries: [
        {
          key: "github.pr.opened",
          description: "A pull request was opened",
          filters: [{ field: "repo", path: "$.repository.full_name", description: "repo" }],
        },
        { key: "github.pr.merged", description: "A pull request was merged", filters: [] },
      ],
    },
  ],
};

/** A long error, so a truncation regression shows up as a failed substring
 * match rather than a passing prefix match. */
const subscriptionsData: { subscriptions: EventSubscriptionWire[] } = {
  subscriptions: [
    {
      id: "sub_1",
      name: "PR alerts",
      ownerType: "user",
      ownerId: "u1",
      eventKeys: ["github.pr.opened"],
      filters: [],
      target: { kind: "workflow" as const, workflowId: "wf_1" },
      enabled: true,
      createdBy: "u1",
      createdAt: 1,
      updatedAt: 1,
    },
  ],
};

const workflowsData = {
  workflows: [
    {
      id: "wf_1",
      name: "Deploy pipeline",
      definition: {},
      createdAt: 1,
      updatedAt: 1,
      ownerType: "user" as const,
      ownerId: "u1",
    },
    {
      id: "wf_team",
      name: "Team pipeline",
      definition: {},
      createdAt: 1,
      updatedAt: 1,
      ownerType: "team" as const,
      ownerId: "t_eng",
    },
  ],
};

const patchMutate = vi.fn();
const createMutate = vi.fn();
const deleteMutate = vi.fn();

/** The route's search params, as a module variable the navigate stub
 * writes. Mutating it does NOT re-render — nothing subscribes — so a case
 * that needs the new value on screen must cause a render of its own, which
 * is what a tab click does. Reset in `afterEach`. */
let orgRole = "member";
let searchState: Record<string, unknown> = {};
type NavigateSearch = Record<string, unknown> | ((previous: Record<string, unknown>) => Record<string, unknown>);
const navigateCalls: { search?: NavigateSearch }[] = [];

vi.mock("@tanstack/react-router", () => ({
  createFileRoute: () => (config: unknown) => config,
  useSearch: () => searchState,
  useNavigate: () => (opts: { search?: NavigateSearch }) => {
    navigateCalls.push(opts);
    searchState = typeof opts.search === "function" ? opts.search(searchState) : opts.search ?? {};
  },
  Link: ({
    children,
    to,
    params: _params,
    ...rest
  }: {
    children: ReactNode;
    to?: string;
    params?: Record<string, string>;
    [key: string]: unknown;
  }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

vi.mock("~/components/channels/channels-panel", () => ({ ChannelsPanel: () => <p>Channels list</p> }));

/** The props the page last gave the Log. Its own behaviour is `event-log.test.tsx`'s. */
let logProps: { scope: string; filter: string; query: string; onFilterChange: (next: string) => void } | undefined;
vi.mock("~/components/events/event-log", () => ({
  EventLog: (props: { scope: string; filter: string; query: string; onFilterChange: (next: string) => void }) => {
    logProps = props;
    return <p>Log list</p>;
  },
}));

vi.mock("~/api/events", () => ({
  useEventCatalog: () => ({ data: catalogData, isLoading: false, error: null }),
  useEventSubscriptions: () => ({ data: subscriptionsData, isPending: false, error: null }),
  usePatchEventSubscription: () => ({ mutate: patchMutate, isPending: false }),
  useCreateEventSubscription: () => ({ mutate: createMutate, isPending: false }),
  useDeleteEventSubscription: () => ({ mutate: deleteMutate, isPending: false, error: null }),
}));

vi.mock("~/api/workflows", () => ({
  useWorkflows: () => ({ data: workflowsData, isLoading: false, error: null }),
  // The AutomationWizard imports this for its schedule branch. The event
  // branch never calls it, but the hook must exist for the wizard to render.
  useCreateSchedule: () => ({ mutate: vi.fn(), isPending: false }),
}));

// Teams back the subscription owner badges and the workspace-scoped create
// target. Mutable so team cases can add fixtures; reset in afterEach.
let teamsData: { teams: TeamSummary[] } = { teams: [] };
vi.mock("~/api/settings", () => ({
  // `isError` is read by both events surfaces: it is what separates an
  // owner that has not resolved YET from one that never will.
  useMe: () => ({
    data: { id: "u1", orgId: "org_1", orgRole },
    isLoading: false,
    isError: false,
    error: null,
  }),
  useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
  useOrg: () => ({
    data: { features: { organizations: true } },
    isLoading: false,
    error: null,
  }),
}));

// `OwnerBadge` reads the assistants list to link a team badge to the team's
// assistant; no assistant fixtures needed — an unlinked badge still names
// the owner.

// The create dialog inherits the switcher's workspace. Mutable for the
// team-scope case; reset in afterEach (isolate: false shares the registry).
let scopeTeamId: string | undefined;
vi.mock("~/lib/workspace-scope", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/workspace-scope")>();
  return {
    ...actual,
    useWorkspaceScope: () => ({
      key: scopeTeamId ?? "user",
      teamId: scopeTeamId,
      available: ["user"],
      setKey: () => {},
    }),
  };
});

import { EventsPage, readEventsSearch } from "./events.index";

function team(id: string, name: string, callerRole: "admin" | "member" | null): TeamSummary {
  return {
    id,
    orgId: "org_1",
    name,
    origin: "local",
    externalId: null,
    createdAt: 0,
    memberCount: 3,
    callerRole,
    defaultModel: null,
  };
}

beforeEach(() => {
  orgRole = "member";
  patchMutate.mockClear();
  createMutate.mockClear();
  deleteMutate.mockClear();
});

afterEach(() => {
  teamsData = { teams: [] };
  scopeTeamId = undefined;
  searchState = {};
  navigateCalls.length = 0;
});

describe("EventsPage — Channels", () => {
  it("opens on Channels when the URL names no tab", () => {
    render(<EventsPage />);
    expect(screen.getByRole("tab", { name: "Channels" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Channels list")).toBeTruthy();
  });
});

describe("EventsPage — Log", () => {
  it("opens the Log from the old Activity, Event Logs, and Problems links", () => {
    for (const tab of ["activity", "logs", "problems"]) {
      expect(readEventsSearch({ tab }).tab).toBe("log");
    }
    expect(readEventsSearch({ tab: "problems", problemsQ: "signature" }).q).toBe("signature");
    expect(readEventsSearch({ tab: "receipts" })).toEqual({ tab: "log", status: "receipts" });
  });

  it("passes the URL's scope, status, and search to the Log", () => {
    searchState = { tab: "log", scope: "all", status: "failed", q: "slack" };
    render(<EventsPage />);
    expect(screen.getByRole("tab", { name: "Log" }).getAttribute("aria-selected")).toBe("true");
    expect(logProps).toMatchObject({ scope: "all", filter: "failed", query: "slack" });
  });

  it("writes a filter change to the URL and keeps the other filters", () => {
    searchState = { tab: "log", scope: "all", q: "slack" };
    render(<EventsPage />);
    logProps?.onFilterChange("rejected");
    expect(searchState).toEqual({ tab: "log", scope: "all", status: "rejected", q: "slack" });
    logProps?.onFilterChange("all");
    expect(searchState).toEqual({ tab: "log", scope: "all", q: "slack" });
  });

  it("writes tab changes to the URL so history restores the selected tab", async () => {
    const page = render(<EventsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "Log" }));
    expect(searchState).toEqual({ tab: "log" });
    searchState = {};
    page.rerender(<EventsPage />);
    await waitFor(() => expect(screen.getByRole("tab", { name: "Channels" }).getAttribute("aria-selected")).toBe("true"));
  });
});

describe("EventsPage — Subscriptions", () => {
  function openSubscriptionsTab() {
    // `TooltipProvider` because `OwnerBadge` (team badges) renders a Radix
    // tooltip — same wrapper `-workflows.index.test.tsx` uses.
    render(
      <TooltipProvider>
        <EventsPage />
      </TooltipProvider>,
    );
    fireEvent.click(screen.getByRole("tab", { name: "Subscriptions" }));
  }

  function clickNext() {
    fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
  }

  /**
   * Open the AutomationWizard and drive the raw event branch to the "Then"
   * step, where the target radios live. Step order: What → Match → Then →
   * Review. The advanced outcome is the raw event + filter + target flow.
   */
  function openWizardToTargetStep(eventKey: string) {
    fireEvent.click(screen.getByRole("button", { name: /Manual setup/ }));
    fireEvent.click(screen.getByLabelText(/Advanced \/ custom trigger/)); // What: raw event flow
    clickNext(); // What → Match
    fireEvent.click(screen.getByText(eventKey)); // pick the event key
    clickNext(); // Match → Then
  }

  it("lists subscriptions with the workflow target resolved to its name", () => {
    openSubscriptionsTab();
    expect(screen.getByText("PR alerts")).toBeTruthy();
    expect(screen.getByText(/Run workflow: Deploy pipeline/)).toBeTruthy();
  });

  it("toggles enabled through the patch mutation", () => {
    openSubscriptionsTab();
    fireEvent.click(screen.getByRole("switch", { name: "Disable PR alerts" }));
    expect(patchMutate).toHaveBeenCalledWith(
      { id: "sub_1", body: { enabled: false } },
      expect.anything(),
    );
  });

  it("hides another user's personal subscription outside the selected workspace", () => {
    subscriptionsData.subscriptions[0].ownerId = "someone-else";
    try {
      openSubscriptionsTab();
      expect(screen.queryByRole("button", { name: "PR alerts actions" })).toBeNull();
      expect(screen.queryByRole("switch", { name: "Disable PR alerts" })).toBeNull();
      expect(screen.queryByText("PR alerts")).toBeNull();
    } finally {
      subscriptionsData.subscriptions[0].ownerId = "u1";
    }
  });

  it("the viewer's own personal subscription carries no badge", () => {
    openSubscriptionsTab();
    expect(screen.queryByText("Personal")).toBeNull();
  });

  it("creates a subscription from a name, catalog-picked keys, and the default target", async () => {
    openSubscriptionsTab();
    // Drive the wizard: When → Match (pick key) → Then (personal default) →
    // Review (name, create).
    openWizardToTargetStep("github.pr.merged");
    clickNext(); // Then → Review, keeping the personal-assistant default.

    fireEvent.change(screen.getByLabelText("Automation name"), {
      target: { value: "Merged PRs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create automation" }));

    await waitFor(() =>
      expect(createMutate).toHaveBeenCalledWith(
        {
          name: "Merged PRs",
          eventKeys: ["github.pr.merged"],
          filters: [],
          target: { kind: "orchestrator", orchestrator: "user", deliveryPolicy: "always", pauseOnOverlap: true },
        },
        expect.anything(),
      ),
    );
  });

  it("badges a team-owned subscription with the team's name and lets a member manage it", () => {
    teamsData = { teams: [team("t_eng", "Engineering", "member")] };
    scopeTeamId = "t_eng";
    subscriptionsData.subscriptions[0].ownerType = "team";
    subscriptionsData.subscriptions[0].ownerId = "t_eng";
    try {
      openSubscriptionsTab();
      expect(screen.getAllByText("Engineering").length).toBeGreaterThan(0);
      const toggle = screen.getByRole("switch", { name: "Disable PR alerts" }) as HTMLButtonElement;
      expect(toggle.disabled).toBe(false);
    } finally {
      subscriptionsData.subscriptions[0].ownerType = "user";
      subscriptionsData.subscriptions[0].ownerId = "u1";
    }
  });

  it("keeps a non-member's hands off a team subscription (org admin included)", () => {
    teamsData = { teams: [team("t_eng", "Engineering", null)] };
    subscriptionsData.subscriptions[0].ownerType = "team";
    subscriptionsData.subscriptions[0].ownerId = "t_eng";
    try {
      openSubscriptionsTab();
      expect(screen.queryByRole("switch", { name: "Disable PR alerts" })).toBeNull();
      expect(screen.queryByRole("button", { name: "PR alerts actions" })).toBeNull();
    } finally {
      subscriptionsData.subscriptions[0].ownerType = "user";
      subscriptionsData.subscriptions[0].ownerId = "u1";
    }
  });

  it("in a team workspace, the create dialog targets the team's assistant by default", async () => {
    teamsData = { teams: [team("t_eng", "Engineering", "member")] };
    scopeTeamId = "t_eng";
    openSubscriptionsTab();
    openWizardToTargetStep("github.pr.merged");

    // On the Then step, the team option exists and is preselected.
    const teamRadio = screen.getByRole("radio", {
      name: /Notify Engineering/,
    }) as HTMLInputElement;
    expect(teamRadio.checked).toBe(true);

    clickNext(); // Then → Review, keeping the team default.
    fireEvent.change(screen.getByLabelText("Automation name"), {
      target: { value: "Team PRs" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create automation" }));

    await waitFor(() =>
      expect(createMutate).toHaveBeenCalledWith(
        {
          name: "Team PRs",
          eventKeys: ["github.pr.merged"],
          filters: [],
          target: { kind: "orchestrator", orchestrator: "team", teamId: "t_eng" },
        },
        expect.anything(),
      ),
    );
  });

  // In a team workspace the Then step offers every target: the team default
  // plus a switch to the personal, org, and workflow targets. The wizard no
  // longer prints an "ownership lands elsewhere" note (the old dialog did),
  // so this asserts the target choices are present and switchable — the
  // intent that team-target visibility follows the workspace.
  it("in a team workspace, offers the team default and a switch to every other target", () => {
    teamsData = { teams: [team("t_eng", "Engineering", "member")] };
    scopeTeamId = "t_eng";
    workflowsData.workflows.push({
      id: "wf_extra",
      name: "Nightly",
      definition: {},
      createdAt: 1,
      updatedAt: 1,
      ownerType: "user" as const,
      ownerId: "u1",
    });
    try {
      openSubscriptionsTab();
      openWizardToTargetStep("github.pr.merged");

      // The team target is the default.
      const teamRadio = screen.getByRole("radio", {
        name: /Notify Engineering/,
      }) as HTMLInputElement;
      expect(teamRadio.checked).toBe(true);

      // The reader can switch to the personal, org, and workflow targets.
      const userRadio = screen.getByRole("radio", { name: /Notify your personal workspace/ });
      fireEvent.click(userRadio);
      expect((userRadio as HTMLInputElement).checked).toBe(true);

      const workflowRadio = screen.getByRole("radio", { name: /Run a workflow/ });
      fireEvent.click(workflowRadio);
      expect((workflowRadio as HTMLInputElement).checked).toBe(true);

      const orgRadio = screen.getByRole("radio", { name: /Notify the organization/ });
      fireEvent.click(orgRadio);
      expect((orgRadio as HTMLInputElement).checked).toBe(true);
    } finally {
      workflowsData.workflows = workflowsData.workflows.filter((w) => w.id !== "wf_extra");
    }
  });

  it("personal workspace: the Then step shows target options and no ownership note", () => {
    openSubscriptionsTab();
    openWizardToTargetStep("github.pr.merged");
    // The wizard names the target plainly; it prints no "ownership follows the
    // target" note (the old dialog's copy is gone).
    expect(screen.queryByText(/Ownership follows the target/)).toBeNull();
    expect(screen.getByRole("radio", { name: /Notify your personal workspace/ })).toBeTruthy();
  });

  // A workflow target is chosen through the wizard's plain Workflow select.
  // The wizard no longer prints where the row lands, so this drives the
  // create body instead: a workflow target posts `{ kind: "workflow" }`.
  it("personal workspace: a workflow target posts a workflow-kind subscription", async () => {
    teamsData = { teams: [team("t_eng", "Engineering", "member")] };
    openSubscriptionsTab();
    openWizardToTargetStep("github.pr.merged");

    fireEvent.click(screen.getByRole("radio", { name: /Run a workflow/ }));
    // The wizard's workflow picker is a plain `<select aria-label="Workflow">`.
    fireEvent.change(screen.getByLabelText("Workflow"), { target: { value: "wf_team" } });
    clickNext(); // Then → Review

    fireEvent.change(screen.getByLabelText("Automation name"), {
      target: { value: "Team deploy" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Create automation" }));

    await waitFor(() =>
      expect(createMutate).toHaveBeenCalledWith(
        {
          name: "Team deploy",
          eventKeys: ["github.pr.merged"],
          filters: [],
          target: { kind: "workflow", workflowId: "wf_team" },
        },
        expect.anything(),
      ),
    );
  });

  it("personal workspace: no team target is offered", () => {
    teamsData = { teams: [team("t_eng", "Engineering", "member")] };
    openSubscriptionsTab();
    openWizardToTargetStep("github.pr.merged");
    expect(screen.queryByRole("radio", { name: /Engineering/ })).toBeNull();
  });

  it("deletes a subscription after the confirm dialog", async () => {
    openSubscriptionsTab();
    // Radix dropdown triggers do not open from jsdom's plain click; the
    // keyboard path (Enter) is the reliable way to open one in tests.
    fireEvent.keyDown(screen.getByRole("button", { name: "PR alerts actions" }), { key: "Enter" });
    fireEvent.click(await screen.findByText("Delete subscription"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete subscription" }));
    expect(deleteMutate).toHaveBeenCalledWith("sub_1", expect.anything());
  });

  async function openEditDialog() {
    fireEvent.keyDown(screen.getByRole("button", { name: "PR alerts actions" }), { key: "Enter" });
    fireEvent.click(await screen.findByText("Edit subscription"));
  }

  it("edit: the form is prefilled and a rename patches only the name", async () => {
    openSubscriptionsTab();
    await openEditDialog();

    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    expect(nameInput.value).toBe("PR alerts");
    const key = screen.getByRole("checkbox", {
      name: /A pull request was opened/,
    }) as HTMLInputElement;
    expect(key.checked).toBe(true);

    fireEvent.change(nameInput, { target: { value: "PR alerts (prod)" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(patchMutate).toHaveBeenCalledWith(
      { id: "sub_1", body: { name: "PR alerts (prod)" } },
      expect.anything(),
    );
  });

  it("edit: adding an event key patches the full key list", async () => {
    openSubscriptionsTab();
    await openEditDialog();
    fireEvent.click(screen.getByRole("checkbox", { name: /A pull request was merged/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(patchMutate).toHaveBeenCalledWith(
      { id: "sub_1", body: { eventKeys: ["github.pr.opened", "github.pr.merged"] } },
      expect.anything(),
    );
  });

  it("edit: a save with no changes closes without a write", async () => {
    openSubscriptionsTab();
    await openEditDialog();
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(patchMutate).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByLabelText("Name")).toBeNull());
  });

  it("edit: the target is shown read-only, with no target controls", async () => {
    openSubscriptionsTab();
    await openEditDialog();
    // The dialog names the stored target (the row shows it too, hence "all").
    expect(screen.getAllByText(/Run workflow: Deploy pipeline/).length).toBeGreaterThan(1);
    expect(screen.getByText(/This dialog cannot change the target/)).toBeTruthy();
    expect(screen.queryByRole("radio", { name: /Run a workflow/ })).toBeNull();
  });

  it("edit: refuses Any channel plus a channel filter before the round trip", async () => {
    // A stored any-channel mention rule seeds the checkbox CHECKED, so
    // "narrow it to one channel" walks into the server's refusal of the
    // contradictory pair unless the form gates it first.
    catalogData.services.push({
      service: "slack",
      entries: [
        {
          key: "slack.app_mention",
          description: "The app was mentioned",
          filters: [{ field: "channel", path: "$.event.channel", description: "channel id" }],
        },
      ],
    });
    subscriptionsData.subscriptions[0].eventKeys = ["slack.app_mention"];
    try {
      openSubscriptionsTab();
      await openEditDialog();
      const anyChannel = screen.getByRole("checkbox", { name: /Any channel/ }) as HTMLInputElement;
      expect(anyChannel.checked).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
      fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "C1" } });
      fireEvent.click(screen.getByRole("button", { name: "Save" }));

      expect(screen.getByText(/"Any channel" removes the channel restriction/)).toBeTruthy();
      expect(patchMutate).not.toHaveBeenCalled();
    } finally {
      catalogData.services.pop();
      subscriptionsData.subscriptions[0].eventKeys = ["github.pr.opened"];
    }
  });
});
