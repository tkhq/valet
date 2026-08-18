// @vitest-environment jsdom
/**
 * `/workflows` definitions list (plan decision 11): each row's name links
 * to `/workflows/$workflowId` (the editor), Run starts a run and navigates
 * to the run detail page, and "New workflow" opens `NewWorkflowDialog`
 * (review fix 1), which POSTs the entered name + a minimal trigger→stop
 * definition then navigates to its editor page. `<Link>`/`useNavigate` need
 * router context — mocked the same way `thread-tree-new-thread.test.tsx`
 * does, since this suite only cares that navigation was requested, not
 * that the router actually resolved it.
 *
 * The team row's `OwnerBadge` carries a tooltip, which Radix refuses to
 * render outside a provider, so the page renders inside one here — the same
 * wrapper `session-header.test.tsx` uses.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { WorkflowDefinitionSummary } from "@valet/api/wire";
import { TooltipProvider } from "~/components/primitives";

// Annotated rather than inferred: the empty-list case reassigns `workflows`
// to `[]`, which an inferred tuple would reject. The wire type stands in for
// a hand-listed shape so a new field cannot drift out of this fixture.
const workflowsData: { workflows: WorkflowDefinitionSummary[] } = {
  workflows: [
    {
      id: "wf_1",
      name: "Deploy pipeline",
      definition: {},
      createdAt: 1,
      updatedAt: 1,
      ownerType: "user",
      ownerId: "u1",
    },
    {
      id: "wf_2",
      name: "Nightly digest",
      definition: {},
      createdAt: 2,
      updatedAt: 2,
      ownerType: "team",
      ownerId: "team_1",
    },
  ],
};

const teamsData = {
  teams: [
    { id: "team_1", orgId: "org_1", name: "Platform", createdAt: 1, memberCount: 2, callerRole: "admin" as const },
  ],
};

const triggersData = {
  triggers: [
    {
      kind: "schedule" as const,
      id: "sched_1",
      workflowId: "wf_1",
      name: "Nightly build",
      enabled: true,
      detail: {
        cron: "0 2 * * *",
        timezone: "UTC",
        targetKind: "workflow" as const,
        nextFireAt: Date.now() + 86400000,
        lastFiredAt: null,
      },
    },
  ],
};

const allRunsData = {
  runs: [
    {
      runId: "wfrun_1",
      workflowId: "wf_1",
      workflowName: "Deploy pipeline",
      status: "settled" as const,
      outcome: "completed" as const,
      createdAt: Date.now() - 10000,
      updatedAt: Date.now() - 5000,
    },
  ],
};

let searchState: Record<string, unknown> = {};

const navigate = vi.fn();
const startMutateAsync = vi.fn().mockResolvedValue({ runId: "wfrun_new" });
const deleteMutateAsync = vi.fn().mockResolvedValue(undefined);
const createMutateAsync = vi.fn().mockResolvedValue({
  id: "wf_new",
  name: "My new workflow",
  definition: { version: "dag/v1", nodes: [], edges: [] },
  createdAt: 1,
  updatedAt: 1,
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useNavigate: () => navigate,
  // One `useSearch` serves both readers: the hub reads `?tab=`, and the
  // workspace scope reads `?assistant=` so an open assistant can override the
  // stored workspace. This page is never rendered with an assistant, so
  // `searchState` only ever carries the tab.
  useSearch: () => searchState,
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/api/settings", () => ({
  useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
  useOrg: () => ({ data: { features: { organizations: true } }, isLoading: false, error: null }),
  // `useListOwner` reads the caller's own id to address the personal
  // workspace: the workspace switcher holds a routing key, not a principal.
  useMe: () => ({ data: { id: "u-1" }, isLoading: false, error: null }),
}));

// The badge links by assistant id, so it reads the assistants list to find
// the team's default one.
vi.mock("~/api/assistants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/assistants")>();
  return {
    ...actual,
    useAssistants: () => ({
      data: {
        assistants: [
          {
            id: "asst_team_1",
            owner: { type: "team" as const, id: "team_1" },
            sessionId: "assistant:asst_team_1",
            isDefault: true,
            createdAt: 1,
          },
        ],
      },
      isLoading: false,
      error: null,
    }),
  };
});

vi.mock("~/api/workflows", () => ({
  useWorkflows: () => ({ data: workflowsData, isLoading: false, error: null }),
  useWorkflowRuns: () => ({ data: { runs: [] }, isLoading: false }),
  useStartRun: () => ({ mutateAsync: startMutateAsync, isPending: false }),
  useCreateWorkflow: () => ({ mutateAsync: createMutateAsync, isPending: false, error: null }),
  useDeleteWorkflow: () => ({ mutateAsync: deleteMutateAsync, isPending: false }),
  useWorkflowTriggers: () => ({ data: triggersData, isLoading: false, error: null }),
  useAllWorkflowRuns: () => ({ data: allRunsData, isLoading: false, error: null }),
  useUpdateSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateEventTrigger: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useDeleteEventTrigger: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useRunScheduleNow: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useTriggerCatalog: () => ({ data: { catalog: [] }, isLoading: false, error: null }),
  useCreateSchedule: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useCreateEventTrigger: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));

// The gallery has its own suite; here it only has to be identifiable, so the
// page's placement rule can be asserted without a second templates fixture.
vi.mock("~/components/workflows/template-gallery", () => ({
  TemplateGallery: () => <div data-testid="template-gallery" />,
}));

import { WorkflowsIndexPage } from "./workflows.index";
import { PERSONAL, WorkspaceScopeProvider } from "~/lib/workspace-scope";

/** `workspace` selects the workspace the page is being read in — what the
 * nav's switcher sets. Seeded through localStorage, which is where the real
 * scope lives. */
function renderPage(workspace = PERSONAL) {
  window.localStorage.setItem("valet:workspace", workspace);
  return render(
    <TooltipProvider>
      <WorkspaceScopeProvider>
        <WorkflowsIndexPage />
      </WorkspaceScopeProvider>
    </TooltipProvider>,
  );
}

const populated = [...workflowsData.workflows];

beforeEach(() => {
  workflowsData.workflows = [...populated];
  searchState = {};
  navigate.mockClear();
  deleteMutateAsync.mockClear();
});

describe("WorkflowsIndexPage", () => {
  it("renders each workflow definition's name as a link to its editor page", () => {
    renderPage();
    const link = screen.getByText("Deploy pipeline").closest("a");
    expect(link?.getAttribute("href") ?? link?.getAttribute("to")).toBeTruthy();
    expect(screen.getByText("Nightly digest")).toBeTruthy();
  });

  it("starts a run and navigates to the run detail page when Run is clicked", async () => {
    renderPage();
    const runButtons = screen.getAllByRole("button", { name: "Run" });
    fireEvent.click(runButtons[0]);

    await waitFor(() => expect(startMutateAsync).toHaveBeenCalled());
    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/workflows/runs/$runId",
        params: { runId: "wfrun_new" },
      }),
    );
  });

  it("runs immediately, with no dialog, when the trigger's only field is hidden", async () => {
    // github.pull-request-review and github.assign-reviewers, once
    // installed, declare exactly one trigger field: a hidden webhook
    // payload nobody types. Run must not open a dialog asking for it.
    workflowsData.workflows = [
      {
        id: "wf_event_only",
        name: "Review a pull request when it opens or updates",
        definition: {
          version: "dag/v1",
          nodes: [
            {
              id: "start",
              type: "trigger",
              dataSchema: { payload: { type: "object", hidden: true } },
            },
          ],
          edges: [],
        },
        createdAt: 1,
        updatedAt: 1,
        ownerType: "user",
        ownerId: "u1",
      },
    ];
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    await waitFor(() => expect(startMutateAsync).toHaveBeenCalled());
    expect(screen.queryByText("payload")).toBeNull();
    expect(screen.queryByText(/This workflow's trigger declares inputs/)).toBeNull();
  });

  it("opens the New workflow dialog, defaults the name field, and posts the entered name on Create", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));

    const nameInput = screen.getByLabelText("Name") as HTMLInputElement;
    expect(nameInput.value).toBe("Untitled workflow");
    fireEvent.change(nameInput, { target: { value: "My new workflow" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    const call = createMutateAsync.mock.calls[0]![0] as {
      name: string;
      definition: { nodes: Array<{ id: string; type: string }>; edges: Array<{ from: string; to: string }> };
    };
    expect(call.name).toBe("My new workflow");
    expect(call.definition.nodes.map((n) => n.type)).toEqual(["trigger", "stop"]);
    expect(call.definition.edges).toEqual([{ from: "trigger", to: "stop" }]);

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/workflows/$workflowId",
        params: { workflowId: "wf_new" },
      }),
    );
  });

  it("asks in-page before deleting a workflow, and only deletes once confirmed", async () => {
    renderPage();
    fireEvent.click(screen.getByLabelText("Delete Deploy pipeline"));
    expect(deleteMutateAsync).not.toHaveBeenCalled();

    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Settled run history is kept/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete workflow" }));

    await waitFor(() => expect(deleteMutateAsync).toHaveBeenCalledWith("wf_1"));
  });

  it("shows the Workflows tab by default with per-workflow trigger badges", () => {
    renderPage();
    expect(screen.getByText("Deploy pipeline")).toBeTruthy();
    expect(screen.getByLabelText(/1 schedule/)).toBeTruthy();
  });

  it("renders the Runs tab from the global runs feed", () => {
    searchState = { tab: "runs" };
    renderPage();
    expect(screen.getByText("Deploy pipeline")).toBeTruthy(); // workflowName column
    expect(screen.getByText("completed")).toBeTruthy(); // RunStatusChip label
  });

  it("renders the Triggers tab with the unified list", () => {
    searchState = { tab: "triggers" };
    renderPage();
    expect(screen.getByText("Nightly build")).toBeTruthy();
  });

  it("tab buttons navigate via search params", () => {
    renderPage();
    fireEvent.click(screen.getByRole("tab", { name: /Triggers/ }));
    expect(navigate).toHaveBeenCalledWith(expect.objectContaining({ search: { tab: "triggers" } }));
  });

  it("puts templates behind a tab so an existing list stays the page", () => {
    renderPage();

    expect(screen.getByText("Deploy pipeline")).toBeTruthy();
    expect(screen.queryByTestId("template-gallery")).toBeNull();

    fireEvent.click(screen.getByRole("tab", { name: "Templates" }));
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ search: { tab: "templates" } }),
    );

    searchState = { tab: "templates" };
    renderPage();
    expect(screen.getByTestId("template-gallery")).toBeTruthy();
  });

  it("makes the gallery the zero state when there are no workflows", () => {
    workflowsData.workflows = [];
    renderPage();

    expect(screen.getByTestId("template-gallery")).toBeTruthy();
    expect(screen.getByText(/no workflows yet/i)).toBeTruthy();
  });
});

describe("WorkflowsIndexPage — team ownership", () => {
  it("badges a team-owned workflow with its team name, linked to that team's assistant", () => {
    renderPage();
    const badge = screen.getByText("Platform");
    expect(badge.closest("a")?.getAttribute("to")).toBe("/chat");
  });

  it("creates the workflow in the workspace being read, with no second question", async () => {
    // The dialog had an Owner select. It repeated the nav's workspace
    // switcher and could contradict it, so the list could show one
    // workspace while Create filed the new workflow under another.
    renderPage("team_1");
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));

    expect(screen.queryByLabelText("Owner")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalled());
    const call = createMutateAsync.mock.calls.at(-1)![0] as { teamId?: string };
    expect(call.teamId).toBe("team_1");
  });

  it("sends no teamId in your own workspace", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "New workflow" }));
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalled());
    const call = createMutateAsync.mock.calls.at(-1)![0] as { teamId?: string };
    expect(call.teamId).toBeUndefined();
  });
});

