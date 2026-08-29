// @vitest-environment jsdom
/**
 * AutomationWizard — one flow that writes to the right store per branch.
 *
 * These cases pin the wire body each branch posts and the name-based review
 * summary, following the isolate-from-the-network pattern the other web
 * suites use: `~/api/*` is mocked to record what its mutations receive.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type {
  CreateEventSubscriptionRequest,
  CreateWorkflowScheduleRequest,
} from "@valet/api/wire";

const createSubscription = vi.fn();
const createSchedule = vi.fn();

const catalogData = {
  services: [
    {
      service: "github",
      entries: [
        {
          key: "github.pr.opened",
          description: "A pull request was opened",
          filters: [{ field: "branch", description: "Base branch" }],
        },
      ],
    },
  ],
};

vi.mock("~/api/events", () => ({
  useEventCatalog: () => ({ data: catalogData, isLoading: false, error: null }),
  useCreateEventSubscription: () => ({ mutate: createSubscription, isPending: false }),
}));

let workflowsData: { workflows: { id: string; name: string }[] } = { workflows: [] };
vi.mock("~/api/workflows", () => ({
  useWorkflows: () => ({ data: workflowsData, isLoading: false, error: null }),
  useCreateSchedule: () => ({ mutate: createSchedule, isPending: false }),
}));

let teamsData: { teams: { id: string; name: string; memberCount: number }[] } = {
  teams: [{ id: "t_platform", name: "Platform", memberCount: 3 }],
};
vi.mock("~/api/settings", () => ({
  useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
  useOrg: () => ({ data: { features: { organizations: true } }, isLoading: false, error: null }),
}));

// Drive the active workspace: default personal, a team when `scopeTeamId` set.
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

import { AutomationWizard } from "./automation-wizard";

beforeEach(() => {
  createSubscription.mockReset();
  createSchedule.mockReset();
  workflowsData = { workflows: [] };
  teamsData = { teams: [{ id: "t_platform", name: "Platform", memberCount: 3 }] };
});

afterEach(() => {
  scopeTeamId = undefined;
});

function clickNext() {
  fireEvent.click(screen.getByRole("button", { name: /^Next$/ }));
}

describe("AutomationWizard", () => {
  it("posts an event subscription with keys, filter, and a team-assistant target", () => {
    // A team workspace, so the team-assistant option appears.
    scopeTeamId = "t_platform";
    render(<AutomationWizard open onOpenChange={() => {}} />);

    // Step 1 — When: default is event. Next.
    clickNext();

    // Step 2 — Match: pick the key, add a filter, type a value.
    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    fireEvent.click(screen.getByText(/^Add filter$/));
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "main" } });
    clickNext();

    // Step 3 — Then: choose the team's assistant.
    fireEvent.click(screen.getByLabelText(/Notify Platform's assistant/));
    clickNext();

    // Step 4 — Review: name it, create.
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "PR watch" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));

    expect(createSchedule).not.toHaveBeenCalled();
    expect(createSubscription).toHaveBeenCalledTimes(1);
    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.name).toBe("PR watch");
    expect(body.eventKeys).toEqual(["github.pr.opened"]);
    expect(body.filters).toEqual([{ field: "branch", op: "eq", value: "main" }]);
    expect(body.target).toEqual({
      kind: "orchestrator",
      orchestrator: "team",
      teamId: "t_platform",
    });
  });

  it("posts a subscription with a workflow target for an event + workflow rule", () => {
    workflowsData = { workflows: [{ id: "wf_1", name: "Deploy" }] };
    render(<AutomationWizard open onOpenChange={() => {}} />);

    clickNext(); // When: event
    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    clickNext(); // Match

    fireEvent.click(screen.getByLabelText(/Run a workflow/));
    fireEvent.change(screen.getByLabelText("Workflow"), { target: { value: "wf_1" } });
    clickNext(); // Then

    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "PR deploy" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));

    expect(createSchedule).not.toHaveBeenCalled();
    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.target).toEqual({ kind: "workflow", workflowId: "wf_1" });
  });

  it("posts a schedule with a cron on the schedule branch", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);

    // Step 1 — When: switch to schedule.
    fireEvent.click(screen.getByLabelText(/On a schedule/));
    clickNext();

    // Step 2 — Match: cron.
    fireEvent.change(screen.getByLabelText("Cron"), { target: { value: "0 9 * * 1-5" } });
    clickNext();

    // Step 3 — Then: default is your assistant. A prompt appears for a
    // scheduled orchestrator run.
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Daily digest" } });
    clickNext();

    // Step 4 — Review.
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Morning digest" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));

    expect(createSubscription).not.toHaveBeenCalled();
    expect(createSchedule).toHaveBeenCalledTimes(1);
    const body = createSchedule.mock.calls[0][0] as CreateWorkflowScheduleRequest;
    expect(body.name).toBe("Morning digest");
    expect(body.cron).toBe("0 9 * * 1-5");
    expect(body.timezone).toEqual(expect.any(String));
    expect(body.target).toEqual({ kind: "orchestrator", prompt: "Daily digest" });
  });

  it("renders a name-based review summary with no raw ids", () => {
    scopeTeamId = "t_platform";
    render(<AutomationWizard open onOpenChange={() => {}} />);

    clickNext(); // When: event
    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    fireEvent.click(screen.getByText(/^Add filter$/));
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "main" } });
    clickNext(); // Match

    fireEvent.click(screen.getByLabelText(/Notify Platform's assistant/));
    clickNext(); // Then

    // The summary names the team, not its id.
    const summary = screen.getByText(/When github\.pr\.opened arrives/);
    expect(summary.textContent).toContain("notify Platform's assistant");
    expect(summary.textContent).toContain("branch is main");
    expect(summary.textContent).not.toContain("t_platform");
  });

  it("blocks Next until the current step is valid", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);
    clickNext(); // When → Match (event)
    // No event key picked yet: Next is disabled.
    expect((screen.getByRole("button", { name: /^Next$/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    expect((screen.getByRole("button", { name: /^Next$/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
