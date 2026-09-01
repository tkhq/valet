// @vitest-environment jsdom
/**
 * AutomationWizard — one outcome-first flow that writes to the right store per
 * outcome.
 *
 * These cases pin the wire body each outcome posts, following the
 * isolate-from-the-network pattern the other web suites use: `~/api/*` is
 * mocked to record what its mutations receive.
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
  // The reply outcome's channel multi-select calls this. The source cannot
  // resolve here — return a reason so it falls back to the free-text
  // channel-id input the reply tests type into.
  useFilterOptions: () => ({ data: { options: [], reason: "Connect Slack first." }, isLoading: false }),
}));

// The reply step warns when the caller's Slack account is not linked.
vi.mock("~/api/queries", () => ({
  useIdentityLinks: () => ({
    data: {
      links: [
        {
          provider: "slack",
          linked: true,
          channelReady: true,
          codeDelivery: true,
          memberSearch: true,
        },
      ],
    },
    isLoading: false,
    error: null,
  }),
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

function pickOutcome(label: RegExp) {
  fireEvent.click(screen.getByLabelText(label));
}

describe("AutomationWizard", () => {
  /** Adds a channel through the reply step's free-text fallback (the mocked
   * options source returns a reason, so no picker list renders). */
  function addReplyChannel(id: string) {
    fireEvent.change(screen.getByLabelText("Channel id"), { target: { value: id } });
    fireEvent.click(screen.getByRole("button", { name: /^Add channel$/ }));
  }

  it("reply outcome posts slack.app_mention with the picked channel and follow ON", () => {
    // A team workspace, so the team-assistant option appears.
    scopeTeamId = "t_platform";
    render(<AutomationWizard open onOpenChange={() => {}} />);

    // Step 1 — What: reply is the default. Next.
    clickNext();

    // Step 2 — Reply: channels are required now, so add one, then pick the
    // team's assistant and leave follow ON (default).
    addReplyChannel("C123");
    fireEvent.click(screen.getByLabelText(/Platform's assistant/));
    // Follow is a checkbox, default checked.
    const follow = screen.getByRole("checkbox", { name: /Keep following the thread/ });
    expect((follow as HTMLInputElement).checked).toBe(true);
    clickNext();

    // Step 3 — Review: name it, create.
    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Slack replies" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));

    expect(createSchedule).not.toHaveBeenCalled();
    expect(createSubscription).toHaveBeenCalledTimes(1);
    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.name).toBe("Slack replies");
    expect(body.eventKeys).toEqual(["slack.app_mention"]);
    expect(body.filters).toEqual([{ field: "channel", op: "eq", value: "C123", label: "C123" }]);
    expect(body.anyChannel).toBeUndefined();
    expect(body.target).toEqual({
      kind: "orchestrator",
      orchestrator: "team",
      teamId: "t_platform",
      follow: true,
    });
  });

  it("reply outcome posts several channels as one in filter", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);

    clickNext(); // What: reply
    addReplyChannel("C123");
    addReplyChannel("C456");
    clickNext();

    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Two rooms" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));

    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.filters).toEqual([{ field: "channel", op: "in", value: ["C123", "C456"] }]);
  });

  it("reply outcome with Any channel posts no channel filter and the anyChannel flag", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);

    clickNext(); // What: reply

    // Step 2 — Reply: opt out of the channel requirement, turn follow off.
    fireEvent.click(screen.getByRole("checkbox", { name: /Any channel/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Keep following the thread/ }));
    clickNext();

    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "Ping only" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));

    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.eventKeys).toEqual(["slack.app_mention"]);
    expect(body.filters).toEqual([]);
    expect(body.anyChannel).toBe(true);
    // Personal workspace, so the default target is the user's assistant.
    expect(body.target).toEqual({ kind: "orchestrator", orchestrator: "user", follow: false });
  });

  it("blocks Next on the reply step until a channel is picked or Any channel is set", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);
    clickNext(); // What → Reply
    expect((screen.getByRole("button", { name: /^Next$/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Any channel/ }));
    expect((screen.getByRole("button", { name: /^Next$/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("workflow outcome posts a subscription with a workflow target", () => {
    workflowsData = { workflows: [{ id: "wf_1", name: "Deploy" }] };
    render(<AutomationWizard open onOpenChange={() => {}} />);

    pickOutcome(/Run a workflow on an event/);
    clickNext(); // What

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

  it("advanced outcome reaches the raw event picker and posts keys, filter, target", () => {
    scopeTeamId = "t_platform";
    render(<AutomationWizard open onOpenChange={() => {}} />);

    pickOutcome(/Advanced \/ custom trigger/);
    clickNext(); // What

    // Step 2 — Match: the raw event picker. Pick the key, add a filter.
    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    fireEvent.click(screen.getByText(/^Add filter$/));
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "main" } });
    clickNext();

    // Step 3 — Then: choose the team's assistant.
    fireEvent.click(screen.getByLabelText(/Notify Platform's assistant/));
    clickNext();

    fireEvent.change(screen.getByLabelText("Automation name"), { target: { value: "PR watch" } });
    fireEvent.click(screen.getByRole("button", { name: /Create automation/ }));

    expect(createSchedule).not.toHaveBeenCalled();
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

  it("schedule outcome posts a schedule with a cron and an orchestrator prompt", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);

    // Step 1 — What: on a schedule.
    pickOutcome(/On a schedule/);
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

  it("blocks Next until the advanced Match step has an event", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);
    pickOutcome(/Advanced \/ custom trigger/);
    clickNext(); // What → Match
    // No event key picked yet: Next is disabled.
    expect((screen.getByRole("button", { name: /^Next$/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    expect((screen.getByRole("button", { name: /^Next$/ }) as HTMLButtonElement).disabled).toBe(false);
  });
});
