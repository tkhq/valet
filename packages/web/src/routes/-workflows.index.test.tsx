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
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { TooltipProvider } from "~/components/primitives";

const workflowsData = {
  workflows: [
    { id: "wf_1", name: "Deploy pipeline", definition: {}, createdAt: 1, updatedAt: 1, ownerType: "user" as const, ownerId: "u1" },
    { id: "wf_2", name: "Nightly digest", definition: {}, createdAt: 2, updatedAt: 2, ownerType: "team" as const, ownerId: "team_1" },
  ],
};

const teamsData = {
  teams: [
    { id: "team_1", orgId: "org_1", name: "Platform", createdAt: 1, memberCount: 2, callerRole: "admin" as const },
  ],
};

const navigate = vi.fn();
const startMutateAsync = vi.fn().mockResolvedValue({ runId: "wfrun_new" });
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
  createFileRoute: () => (config: unknown) => config,
  // The workspace scope reads `?assistant=` so an open assistant can override
  // the stored workspace. This page is never rendered with one.
  useSearch: () => ({}),
}));

vi.mock("~/api/settings", () => ({
  useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
  useOrg: () => ({ data: { features: { organizations: true } }, isLoading: false, error: null }),
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
  useDeleteWorkflow: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

