// @vitest-environment jsdom
/**
 * AutomationWizard — one outcome-first flow that writes to the right store per
 * outcome.
 *
 * These cases pin the wire body each outcome posts, following the
 * isolate-from-the-network pattern the other web suites use: `~/api/*` is
 * mocked to record what its mutations receive.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import type {
  CreateEventSubscriptionRequest,
  CreateWorkflowScheduleRequest,
  EventSubscriptionWire,
  GetWorkflowTriggerCatalogResponse,
} from "@valet/api/wire";
import { presenceSentence } from "~/components/presence/sentences";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-router")>(),
  Link: ({ to, children }: { to: string; children: ReactNode }) => <a href={to}>{children}</a>,
}));

const createSubscription = vi.fn();
const createSchedule = vi.fn();

const catalogData = {
  services: [
    {
      service: "slack",
      entries: [
        { key: "slack.app_mention", description: "Mention", filters: [{ field: "channel" }] },
        { key: "slack.message", description: "Message", filters: [{ field: "channel" }] },
      ],
    },
    {
      service: "github",
      entries: [
        {
          key: "github.pr.opened",
          description: "A pull request was opened",
          filters: [{ field: "branch", description: "Base branch" }],
        },
        {
          key: "github.check_run.completed",
          description: "A check completed",
          filters: [{ field: "repo", description: "Repository" }],
        },
      ],
    },
  ],
};

/** The mocked catalog in the shape the sentences read. */
const sentenceCatalog: GetWorkflowTriggerCatalogResponse["catalog"] = catalogData.services.map((s) => ({
  service: s.service,
  entries: s.entries.map((e) => ({
    key: e.key,
    description: e.description,
    filters: e.filters.map((f) => ({ field: f.field, description: "description" in f ? f.description : "" })),
  })),
}));

/** A create body as the stored line it becomes, with placeholder ids. */
function storedLine(body: CreateEventSubscriptionRequest): EventSubscriptionWire {
  return {
    id: "stored",
    name: body.name,
    ownerType: "user",
    ownerId: "u1",
    eventKeys: body.eventKeys,
    filters: body.filters ?? [],
    target: body.target,
    enabled: true,
    createdBy: "u1",
    createdAt: 1,
    updatedAt: 1,
  };
}

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

// The thread picker reads the network; the Runs in tests stop before a pick.
// It names the workspace whose threads it would list.
vi.mock("~/components/presence/thread-picker", () => ({
  ThreadPicker: ({ workspace }: { workspace: string }) => <p>Thread picker for {workspace}</p>,
}));

import { ApiError } from "~/api/client";
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

function pickOutcome(label: RegExp | string) {
  fireEvent.click(screen.getByLabelText(label));
}

/** Step 1: the When choice, then the Do choice. */
function pickWhenDo(when: string, todo?: string) {
  fireEvent.click(screen.getByLabelText(when));
  if (todo !== undefined) fireEvent.click(screen.getByLabelText(todo));
}

const GITHUB = "Something happens on GitHub";

function pickAdvanced() {
  fireEvent.click(screen.getByRole("button", { name: "Pick raw events" }));
}

function preview(): string {
  return screen.getByTestId("wizard-preview").textContent ?? "";
}

/** Opens the Runs in field behind its Change button. */
function openRunsIn() {
  fireEvent.click(screen.getByRole("button", { name: "Change" }));
}

describe("AutomationWizard", () => {
  it("reviews a Slack thread permalink before creating a listener on exactly that thread", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);
    pickOutcome(/Follow a Slack thread/);
    expect(createSubscription).not.toHaveBeenCalled();
    clickNext();
    expect((screen.getByRole("button", { name: /^Next$/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Slack thread link"), {
      target: { value: "https://acme.slack.com/archives/C123ABC/p1750000000123456" },
    });
    expect(createSubscription).not.toHaveBeenCalled();
    clickNext();
    expect((screen.getByLabelText(/Notify your personal workspace/) as HTMLInputElement).checked).toBe(true);
    expect(createSubscription).not.toHaveBeenCalled();
    clickNext();
    const review = within(screen.getByLabelText("Summary"));
    expect(review.getByText("When").nextElementSibling?.textContent).toBe("slack.message");
    expect(review.getByText("Scope").nextElementSibling?.textContent).toContain("C123ABC");
    expect(review.getByText("Scope").nextElementSibling?.textContent).toContain("1750000000.123456");
    expect((screen.getByRole("button", { name: "Create" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Follow rollout thread" } });
    expect(createSubscription).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(createSubscription).toHaveBeenCalledTimes(1);
    expect(createSchedule).not.toHaveBeenCalled();
    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.name).toBe("Follow rollout thread");
    expect(body.eventKeys).toEqual(["slack.message"]);
    expect(body.filters).toEqual([
      { field: "channel", op: "eq", value: "C123ABC" },
      { field: "thread_ts", op: "eq", value: "1750000000.123456" },
    ]);
    expect(body.target).toEqual({ kind: "assistant", assistant: "user", follow: false, deliveryPolicy: "always", pauseOnOverlap: true, thread: { mode: "own" } });
  });

  /** Adds a channel through the reply step's free-text fallback (the mocked
   * options source returns a reason, so no picker list renders). */
  function addReplyChannel(id: string) {
    fireEvent.change(screen.getByLabelText("Channel id"), { target: { value: id } });
    fireEvent.click(screen.getByRole("button", { name: /^Add channel$/ }));
  }

  it("homepage setup requires channels and an explicit team assistant, then saves that target", () => {
    render(<AutomationWizard open onOpenChange={() => {}} replyTeam={{ id: "t_platform", name: "Platform" }} />);
    expect(screen.getByRole("heading", { name: "Set up Slack replies" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: "When" })).toBeNull();
    expect(screen.queryByLabelText("Personal workspace")).toBeNull();
    expect(screen.queryByText("Other")).toBeNull();
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.queryByRole("checkbox", { name: /Any channel/ })).toBeNull();
    addReplyChannel("C123");
    expect(screen.queryByLabelText("Assistant")).toBeNull();
    expect(screen.getByRole("button", { name: "Next" }).hasAttribute("disabled")).toBe(false);
    clickNext();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Platform replies" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(createSubscription.mock.calls[0][0]).toMatchObject({
      eventKeys: ["slack.app_mention"],
      filters: [{ field: "channel", op: "eq", value: "C123" }],
      target: { kind: "assistant", assistant: "team", teamId: "t_platform", follow: true },
    });
  });

  it("homepage setup opens on the organization audience and posts it", () => {
    render(<AutomationWizard open onOpenChange={() => {}} replyTeam={{ id: "t_platform", name: "Platform" }} />);
    const anyone = screen.getByLabelText(/Anyone in the organization/) as HTMLInputElement;
    expect(anyone.checked).toBe(true);
    expect((screen.getByLabelText(/Only members of Platform/) as HTMLInputElement).checked).toBe(false);
    expect(screen.getByText(/answers explicit mentions in the selected channels/)).toBeTruthy();
    // Thread following is on by default, so the copy must not read as
    // "explicit mentions only".
    expect(screen.getByText(/from anyone in that thread/)).toBeTruthy();
    expect(screen.getByText(/whoever sends them/)).toBeTruthy();
    expect(screen.getByText(/runs with the team's access and tools/)).toBeTruthy();
    expect(screen.getByText(/does not run or change the team's workflows/)).toBeTruthy();
    addReplyChannel("C123");
    clickNext();
    expect(within(screen.getByLabelText("Summary")).getByText("Audience").nextElementSibling?.textContent).toBe("Anyone in the organization");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Platform replies" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(createSubscription.mock.calls[0][0].audience).toBe("organization");
  });

  it("the team-only audience posts audience team", () => {
    render(<AutomationWizard open onOpenChange={() => {}} replyTeam={{ id: "t_platform", name: "Platform" }} />);
    fireEvent.click(screen.getByLabelText(/Only members of Platform/));
    addReplyChannel("C123");
    clickNext();
    expect(within(screen.getByLabelText("Summary")).getByText("Audience").nextElementSibling?.textContent).toBe("Team members");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Platform replies" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(createSubscription.mock.calls[0][0].audience).toBe("team");
  });

  it("a personal reply rule carries no audience", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);
    clickNext();
    expect(screen.queryByLabelText(/Anyone in the organization/)).toBeNull();
    addReplyChannel("C123");
    clickNext();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Mine" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(createSubscription.mock.calls[0][0].audience).toBeUndefined();
  });

  it("reply outcome posts slack.app_mention with the picked channel and follow ON", () => {
    // The team workspace seeds the team assistant.
    scopeTeamId = "t_platform";
    render(<AutomationWizard open onOpenChange={() => {}} />);

    // Step 1 — What: reply is the default. Next.
    clickNext();

    // Step 2 — Reply: channels are required now, so add one, and leave
    // follow ON (default). The team radio is available.
    expect(screen.getByText(/The team owns and administers the assistant/)).toBeTruthy();
    addReplyChannel("C123");
    const teamRadio = screen.getByRole("radio", { name: "Platform" }) as HTMLInputElement;
    expect(teamRadio.disabled).toBe(false);
    fireEvent.click(teamRadio);
    expect(teamRadio.checked).toBe(true);
    // Follow is a checkbox, default checked.
    const follow = screen.getByRole("checkbox", { name: /Keep following the thread/ });
    expect((follow as HTMLInputElement).checked).toBe(true);
    clickNext();

    // Step 3 — Review: name it, create.
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Slack replies" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(createSchedule).not.toHaveBeenCalled();
    expect(createSubscription).toHaveBeenCalledTimes(1);
    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.name).toBe("Slack replies");
    expect(body.eventKeys).toEqual(["slack.app_mention"]);
    expect(body.filters).toEqual([{ field: "channel", op: "eq", value: "C123", label: "C123" }]);
    expect(body.anyChannel).toBeUndefined();
    expect(body.target).toEqual({ kind: "assistant", assistant: "team", teamId: "t_platform", follow: true, thread: { mode: "new" } });
  });

  it("reply step offers the team target with member-only copy", () => {
    scopeTeamId = "t_platform";
    render(<AutomationWizard open onOpenChange={() => {}} />);
    expect((screen.getByLabelText("Reply") as HTMLInputElement).checked).toBe(true);
    clickNext();
    expect(screen.getByText(/Valet replies with the organization/)).toBeTruthy();
    expect(screen.getByText(/Choose below who may invoke it by mention/)).toBeTruthy();
    expect((screen.getByRole("radio", { name: "Platform" }) as HTMLInputElement).disabled).toBe(false);
    expect(screen.getByText(/no linked account runs as the person who set this up/)).toBeTruthy();
    // The review describes the selected team's member scope.
    addReplyChannel("C123");
    clickNext();
    const review = within(screen.getByLabelText("Summary"));
    expect(review.getByText("Destination").nextElementSibling?.textContent).toBe("notify Platform's assistant");
    expect(review.getByText("Result").nextElementSibling?.textContent).toBe("When someone mentions Valet in C123, reply in a new thread.");
  });

  it("a personal reply rule in a team workspace keeps creator-only copy and target", () => {
    scopeTeamId = "t_platform";
    render(<AutomationWizard open onOpenChange={() => {}} />);
    clickNext();
    fireEvent.click(screen.getByLabelText(/^Personal workspace/));
    expect(screen.getByText(/do not reach your assistant/)).toBeTruthy();
    addReplyChannel("C123");
    clickNext();
    expect(within(screen.getByLabelText("Summary")).getByText("Destination").nextElementSibling?.textContent).toBe("notify your assistant");
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Personal" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(createSubscription.mock.calls[0][0].target).toEqual({ kind: "assistant", assistant: "user", follow: true, deliveryPolicy: "always", pauseOnOverlap: true, thread: { mode: "new" } });
  });

  it("a team reply rule keeps the selected assistant through review and create", () => {
    scopeTeamId = "t_platform";
    render(<AutomationWizard open onOpenChange={() => {}} />);
    clickNext();
    addReplyChannel("C123");
    clickNext();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Team ops" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(createSubscription.mock.calls[0][0].target).toEqual({ kind: "assistant", assistant: "team", teamId: "t_platform", follow: true, thread: { mode: "new" } });
  });

  it("reply step keeps the org assistant reachable in a team workspace", () => {
    scopeTeamId = "t_platform";
    render(<AutomationWizard open onOpenChange={() => {}} />);
    clickNext();
    addReplyChannel("C123");
    fireEvent.click(screen.getByLabelText(/The org assistant/));
    expect(screen.getByText(/do not reach the org assistant/)).toBeTruthy();
    clickNext();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Org replies" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.target).toEqual({ kind: "assistant", assistant: "org", follow: true, thread: { mode: "new" } });
  });

  it("reply outcome posts several channels as one in filter", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);

    clickNext(); // What: reply
    addReplyChannel("C123");
    addReplyChannel("C456");
    clickNext();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Two rooms" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    // The free-text fallback labels a typed id with itself; the picker path
    // would carry channel names here instead.
    expect(body.filters).toEqual([
      { field: "channel", op: "in", value: ["C123", "C456"], labels: ["C123", "C456"] },
    ]);
  });

  it("reply outcome with Any channel posts no channel filter and the anyChannel flag", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);

    clickNext(); // What: reply

    // Step 2 — Reply: opt out of the channel requirement, turn follow off.
    fireEvent.click(screen.getByRole("checkbox", { name: /Any channel/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Keep following the thread/ }));
    clickNext();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Ping only" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.eventKeys).toEqual(["slack.app_mention"]);
    expect(body.filters).toEqual([]);
    expect(body.anyChannel).toBe(true);
    // Personal workspace, so the default target is the user's assistant.
    expect(body.target).toEqual({ kind: "assistant", assistant: "user", follow: false, deliveryPolicy: "always", pauseOnOverlap: true, thread: { mode: "new" } });
  });

  it("blocks Next on the reply step until a channel is picked or Any channel is set", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);
    clickNext(); // What → Reply
    expect((screen.getByRole("button", { name: /^Next$/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /Any channel/ }));
    expect((screen.getByRole("button", { name: /^Next$/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("drops a picked team target when the workspace switches back to personal", () => {
    scopeTeamId = "t_platform";
    const view = render(<AutomationWizard open onOpenChange={() => {}} />);

    pickWhenDo(GITHUB, "Work on it");
    clickNext(); // When
    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    clickNext(); // What

    // The reader moves off the seeded team target and then picks it by hand
    // (a pick, not the seed, is what a workspace switch must not keep), then
    // leaves the team workspace.
    fireEvent.click(screen.getByLabelText(/Notify your personal workspace/));
    fireEvent.click(screen.getByLabelText(/Notify Platform/));
    scopeTeamId = undefined;
    view.rerender(<AutomationWizard open onOpenChange={() => {}} />);

    // The team option is gone, and the held target followed the workspace.
    expect(screen.queryByLabelText(/Notify Platform/)).toBeNull();
    expect((screen.getByLabelText(/Notify your personal workspace/) as HTMLInputElement).checked).toBe(true);
    clickNext(); // Then

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "PR ping" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.target).toEqual({ kind: "assistant", assistant: "user", follow: false, deliveryPolicy: "always", pauseOnOverlap: true, thread: { mode: "subject" } });
  });

  it("workflow outcome posts a subscription with a workflow target", () => {
    workflowsData = { workflows: [{ id: "wf_1", name: "Deploy" }] };
    render(<AutomationWizard open onOpenChange={() => {}} />);

    pickWhenDo(GITHUB, "Run a workflow");
    clickNext(); // When

    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    clickNext(); // Match

    fireEvent.click(screen.getByLabelText(/Run a workflow/));
    fireEvent.change(screen.getByLabelText("Workflow"), { target: { value: "wf_1" } });
    clickNext(); // Then

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "PR deploy" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(createSchedule).not.toHaveBeenCalled();
    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.target).toEqual({ kind: "workflow", workflowId: "wf_1" });
  });

  it("advanced outcome reaches the raw event picker and posts keys, filter, target", () => {
    scopeTeamId = "t_platform";
    render(<AutomationWizard open onOpenChange={() => {}} />);

    pickAdvanced();
    clickNext(); // What

    // Step 2 — Match: the raw event picker. Pick the key, add a filter.
    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    fireEvent.click(screen.getByText(/^Add filter$/));
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "main" } });
    clickNext();

    // Step 3 — Then: choose the team's assistant.
    fireEvent.click(screen.getByLabelText(/Notify Platform/));
    clickNext();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "PR watch" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(createSchedule).not.toHaveBeenCalled();
    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.name).toBe("PR watch");
    expect(body.eventKeys).toEqual(["github.pr.opened"]);
    expect(body.filters).toEqual([{ field: "branch", op: "eq", value: "main" }]);
    expect(body.target).toEqual({
      thread: { mode: "own" },
      kind: "assistant",
      assistant: "team",
      teamId: "t_platform",
    });
  });

  function submitAdvanced() {
    clickNext();
    clickNext();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Match rule" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
  }

  it("prunes only unsupported filters as selected events change", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);
    pickAdvanced();
    clickNext();
    fireEvent.click(screen.getByRole("checkbox", { name: /slack\.app_mention/ }));
    fireEvent.click(screen.getByText(/^Add filter$/));
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "C123" } });
    fireEvent.click(screen.getByRole("checkbox", { name: /slack\.message/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /slack\.app_mention/ }));
    expect(screen.getByDisplayValue("C123")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /slack\.message/ }));
    expect(screen.queryByLabelText("Filter value")).toBeNull();
    submitAdvanced();
    expect(createSubscription.mock.calls[0][0]).toMatchObject({ eventKeys: ["github.pr.opened"], filters: [] });
  });

  it.each(["", "C123"])("refuses invalid mention filters before creating (%s)", (value) => {
    render(<AutomationWizard open onOpenChange={() => {}} />);
    pickAdvanced();
    clickNext();
    fireEvent.click(screen.getByRole("checkbox", { name: /slack\.app_mention/ }));
    fireEvent.click(screen.getByText(/^Add filter$/));
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value } });
    fireEvent.click(screen.getByRole("checkbox", { name: /Any channel/ }));
    submitAdvanced();
    expect(createSubscription).not.toHaveBeenCalled();
    expect(screen.getByText(value ? /removes the channel restriction/ : /Enter a value for/)).toBeTruthy();
  });

  // The server refuses a bad template by naming the wire field, the way every
  // sibling refusal in that validator does. If the form does not show the same
  // name, a reader told to move a variable to userPromptTemplate is looking for
  // a box that does not exist under that name.
  it("names the wire field beside each prompt label, so a server refusal points somewhere", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);
    clickNext();
    fireEvent.click(screen.getByRole("checkbox", { name: /Any channel/ }));

    const system = screen.getByLabelText(/Instructions for the assistant/);
    const user = screen.getByLabelText(/Event message/);
    expect(system.closest("div")?.textContent).toContain("systemPrompt");
    expect(user.closest("div")?.textContent).toContain("userPromptTemplate");
  });

  it("reply outcome posts the prompt templates it collected on the mention target", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);

    clickNext(); // What. The reply outcome is the default.

    fireEvent.click(screen.getByRole("checkbox", { name: /Any channel/ }));
    fireEvent.change(screen.getByLabelText(/Instructions for the assistant/), {
      target: { value: "Answer in one sentence." },
    });
    fireEvent.change(screen.getByLabelText(/Event message/), {
      target: { value: "Mention: {{event.body}}" },
    });
    clickNext(); // Reply

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Slack replies" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.target).toEqual({
      thread: { mode: "new" },
      kind: "assistant",
      assistant: "user",
      deliveryPolicy: "always",
      pauseOnOverlap: true,
      follow: true,
      systemPrompt: "Answer in one sentence.",
      userPromptTemplate: "Mention: {{event.body}}",
    });
  });

  it("notify outcome posts the prompt templates it collected on the assistant target", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);

    pickWhenDo(GITHUB, "Work on it");
    clickNext(); // When

    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    clickNext(); // What

    // Step 3, Do: your assistant, plus what it should read.
    fireEvent.change(screen.getByLabelText(/Instructions for the assistant/), {
      target: { value: "Triage it. Answer in one sentence." },
    });
    fireEvent.change(screen.getByLabelText(/Event message/), {
      target: { value: "{{event.summary}} on {{refs.repo}}" },
    });
    clickNext();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "PR triage" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.target).toEqual({
      thread: { mode: "subject" },
      kind: "assistant",
      assistant: "user",
      deliveryPolicy: "always",
      pauseOnOverlap: true,
      follow: false,
      systemPrompt: "Triage it. Answer in one sentence.",
      userPromptTemplate: "{{event.summary}} on {{refs.repo}}",
    });
  });

  it("offers no prompt template on a workflow target, whose prompts live on its nodes", () => {
    workflowsData = { workflows: [{ id: "wf-1", name: "Deploy" }] };
    render(<AutomationWizard open onOpenChange={() => {}} />);

    pickWhenDo(GITHUB, "Run a workflow");
    clickNext();
    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    clickNext();

    expect(screen.queryByLabelText(/Instructions for the assistant/)).toBeNull();
    expect(screen.queryByLabelText(/Event message/)).toBeNull();
  });

  it("schedule outcome posts a schedule with a cron and an assistant prompt", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);

    // Step 1 — What: on a schedule.
    pickOutcome(/On a schedule/);
    clickNext();

    // Step 2 — Match: cron.
    fireEvent.change(screen.getByLabelText("Cron"), { target: { value: "0 9 * * 1-5" } });
    clickNext();

    // Step 3 — Then: default is your assistant. A prompt appears for a
    // scheduled assistant run.
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Daily digest" } });
    clickNext();

    // Step 4 — Review.
    fireEvent.change(screen.getByLabelText("Routine name"), { target: { value: "Morning digest" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    expect(createSubscription).not.toHaveBeenCalled();
    expect(createSchedule).toHaveBeenCalledTimes(1);
    const body = createSchedule.mock.calls[0][0] as CreateWorkflowScheduleRequest;
    expect(body.name).toBe("Morning digest");
    expect(body.cron).toBe("0 9 * * 1-5");
    expect(body.timezone).toEqual(expect.any(String));
    expect(body.target).toEqual({ kind: "assistant", prompt: "Daily digest" });
  });

  it("blocks Next until the advanced Match step has an event", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);
    pickAdvanced();
    clickNext(); // What → Match
    // No event key picked yet: Next is disabled.
    expect((screen.getByRole("button", { name: /^Next$/ }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    expect((screen.getByRole("button", { name: /^Next$/ }) as HTMLButtonElement).disabled).toBe(false);
  });

  // ── Collision gate (TKAI-294) ─────────────────────────────────────────────

  /** A collision payload naming one existing rule, as the server builds it. */
  function collisionPayload(kind: "blocking" | "overlapping") {
    const entry = {
      subscription: {
        id: "sub_existing",
        name: "Eng channel replies",
        ownerType: "user",
        ownerId: "u1",
        eventKeys: ["slack.app_mention"],
        filters: [{ field: "channel", op: "eq", value: "C123", label: "#eng" }],
        target: { kind: "assistant" },
        enabled: true,
        createdBy: "u1",
        createdAt: 1,
        updatedAt: 1,
      },
      relation: kind === "blocking" ? "superset" : "subset",
      sharedKeys: ["slack.app_mention"],
    };
    return {
      blocking: kind === "blocking" ? [entry] : [],
      overlapping: kind === "overlapping" ? [entry] : [],
    };
  }

  /** Walks the reply flow to Review and presses Create. */
  function createReplyRule(name: string) {
    clickNext(); // What: reply
    addReplyChannel("C123");
    clickNext(); // Reply → Review
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: name } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
  }

  it("homepage setup never offers to override a colliding responder", () => {
    createSubscription.mockImplementation((_body: unknown, handlers: { onError: (err: Error) => void }) => {
      handlers.onError(new ApiError(409, "collision", { error: "collides", collisions: collisionPayload("blocking") }));
    });
    render(<AutomationWizard open onOpenChange={() => {}} replyTeam={{ id: "t_platform", name: "Platform" }} />);
    addReplyChannel("C123");
    clickNext();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Platform replies" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect(screen.getByText("Eng channel replies")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Create anyway" })).toBeNull();
    expect(screen.getByRole("link", { name: "Open Presence" }).getAttribute("href")).toBe("/presence");
    expect(createSubscription).toHaveBeenCalledTimes(1);
  });

  it("a 409 collision renders the colliding rule and Create anyway resubmits with allowCollision", () => {
    const onOpenChange = vi.fn();
    createSubscription.mockImplementation(
      (_body: unknown, handlers: { onError: (err: Error) => void }) => {
        handlers.onError(
          new ApiError(409, "collision", {
            error: "collides",
            collisions: collisionPayload("blocking"),
          }),
        );
      },
    );
    render(<AutomationWizard open onOpenChange={onOpenChange} />);
    createReplyRule("Wide net");

    // The colliding rule is named inline; the dialog stays open.
    expect(screen.getByText("Eng channel replies")).toBeTruthy();
    expect(screen.getByText("Would replace")).toBeTruthy();
    expect(onOpenChange).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: /^Create anyway$/ }));
    expect(createSubscription).toHaveBeenCalledTimes(2);
    const first = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(first.allowCollision).toBeUndefined();
    const retry = createSubscription.mock.calls[1][0] as CreateEventSubscriptionRequest;
    expect(retry.allowCollision).toBe(true);
  });

  it("a committed overlap shows the warning and Done closes the dialog", () => {
    const onOpenChange = vi.fn();
    createSubscription.mockImplementation(
      (_body: unknown, handlers: { onSuccess: (resp: { collisions?: unknown }) => void }) => {
        handlers.onSuccess({ collisions: collisionPayload("overlapping") });
      },
    );
    render(<AutomationWizard open onOpenChange={onOpenChange} />);
    createReplyRule("Narrow rule");

    // Saved, but the overlap warning holds the dialog open until Done.
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByText("Overlaps")).toBeTruthy();
    expect(screen.getByText("Eng channel replies")).toBeTruthy();
    // The refusal-only actions are gone.
    expect(screen.queryByRole("button", { name: /Create anyway/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: /^Done$/ }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  describe("Runs in", () => {
    function checkedRunsIn(): string {
      if (screen.queryByRole("group", { name: "Runs in" }) === null) openRunsIn();
      const fieldset = screen.getByRole("group", { name: "Runs in" });
      const radios = within(fieldset).getAllByRole("radio");
      const on = radios.find((r) => r instanceof HTMLInputElement && r.checked);
      return on?.parentElement?.textContent ?? "";
    }

    it("a mention rule defaults to a new thread and posts it", () => {
      render(<AutomationWizard open onOpenChange={() => {}} />);
      clickNext();
      addReplyChannel("C123");
      expect(checkedRunsIn()).toBe("A new thread each time");
      expect(screen.getByRole("radio", { name: "One thread per channel" })).toBeTruthy();
      clickNext();
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Replies" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
      expect(body.target).toMatchObject({ kind: "assistant", thread: { mode: "new" } });
    });

    it("a notification with a subject defaults to one thread per subject", () => {
      render(<AutomationWizard open onOpenChange={() => {}} />);
      pickWhenDo(GITHUB, "Work on it");
      clickNext();
      fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
      clickNext();
      expect(screen.getByText("Runs in: One thread per pull request")).toBeTruthy();
      expect(checkedRunsIn()).toBe("One thread per pull request");
      clickNext();
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "PRs" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
      expect(body.target).toMatchObject({ thread: { mode: "subject" } });
    });

    it("an advanced rule defaults to its own thread, and a picked mode wins", () => {
      render(<AutomationWizard open onOpenChange={() => {}} />);
      pickAdvanced();
      clickNext();
      fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
      clickNext();
      expect(checkedRunsIn()).toBe("Its own thread");
      fireEvent.click(screen.getByRole("radio", { name: "A new thread each time" }));
      clickNext();
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Raw" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
      expect(body.target).toMatchObject({ thread: { mode: "new" } });
    });

    it("a workflow target shows no Runs in and posts no thread", () => {
      workflowsData = { workflows: [{ id: "wf_1", name: "Deploy" }] };
      render(<AutomationWizard open onOpenChange={() => {}} />);
      pickWhenDo(GITHUB, "Run a workflow");
      clickNext();
      fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
      clickNext();
      fireEvent.click(screen.getByLabelText(/Run a workflow/));
      expect(screen.queryByRole("group", { name: "Runs in" })).toBeNull();
      expect(screen.queryByText(/^Runs in:/)).toBeNull();
    });

    it("a scheduled prompt offers no subject, defaults to its own thread, and posts thread at the top level", () => {
      render(<AutomationWizard open onOpenChange={() => {}} />);
      pickOutcome(/On a schedule/);
      clickNext();
      fireEvent.change(screen.getByLabelText("Cron"), { target: { value: "0 9 * * 1-5" } });
      clickNext();
      fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Daily digest" } });
      expect(screen.queryByRole("radio", { name: /One thread per/ })).toBeNull();
      expect(checkedRunsIn()).toBe("This routine's thread");
      clickNext();
      fireEvent.change(screen.getByLabelText("Routine name"), { target: { value: "Digest" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      const body = createSchedule.mock.calls[0][0] as CreateWorkflowScheduleRequest;
      expect(body.thread).toEqual({ mode: "own" });
      expect(body.target).toEqual({ kind: "assistant", prompt: "Daily digest" });
    });

    it("blocks Next while an existing thread is chosen but not picked", () => {
      render(<AutomationWizard open onOpenChange={() => {}} />);
      clickNext();
      addReplyChannel("C123");
      openRunsIn();
      fireEvent.click(screen.getByRole("radio", { name: "An existing thread…" }));
      expect(screen.getByText("Pick a thread.")).toBeTruthy();
      expect((screen.getByRole("button", { name: /^Next$/ }) as HTMLButtonElement).disabled).toBe(true);
    });
  });

  describe("preselected place", () => {
    const INCIDENTS = { subject: "slack:T1/C900", service: "slack" as const, label: "#incidents" };
    const ACME_API = { subject: "github:acme/api", service: "github" as const, label: "acme/api" };

    function checkedRunsIn(): string {
      if (screen.queryByRole("group", { name: "Runs in" }) === null) openRunsIn();
      const radios = within(screen.getByRole("group", { name: "Runs in" })).getAllByRole("radio");
      return radios.find((r) => r instanceof HTMLInputElement && r.checked)?.parentElement?.textContent ?? "";
    }

    it("a mention rule opens on the place's channel and replies in a new thread (H5)", () => {
      render(<AutomationWizard open onOpenChange={() => {}} preselectedPlace={INCIDENTS} />);
      pickOutcome("Reply");
      clickNext();
      expect(screen.getByRole("button", { name: "Remove #incidents" })).toBeTruthy();
      expect(checkedRunsIn()).toBe("A new thread each time");
      clickNext();
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Incident replies" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
      expect(body.eventKeys).toEqual(["slack.app_mention"]);
      expect(body.filters).toEqual([{ field: "channel", op: "eq", value: "C900", label: "#incidents" }]);
      expect(body.target).toMatchObject({ kind: "assistant", assistant: "user", thread: { mode: "new" } });
    });

    it("an event rule offers only the place's service and filters on its repository (H6)", () => {
      render(<AutomationWizard open onOpenChange={() => {}} preselectedPlace={ACME_API} />);
      pickOutcome("Work on it");
      clickNext();
      expect(screen.queryByRole("checkbox", { name: /slack\.app_mention/ })).toBeNull();
      fireEvent.click(screen.getByRole("checkbox", { name: /github\.check_run\.completed/ }));
      clickNext();
      expect(checkedRunsIn()).toBe("One thread per pull request");
      const options = within(screen.getByRole("group", { name: "Runs in" })).getAllByRole("radio").map((r) => r.parentElement?.textContent);
      expect(options).toEqual(["A new thread each time", "One thread per pull request", "Its own thread", "An existing thread…"]);
      fireEvent.click(screen.getByRole("radio", { name: "An existing thread…" }));
      expect(screen.getByText("Thread picker for user")).toBeTruthy();
      fireEvent.click(screen.getByRole("radio", { name: "One thread per pull request" }));
      clickNext();
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Failed checks" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
      expect(body.filters).toEqual([{ field: "repo", op: "eq", value: "acme/api", label: "acme/api" }]);
      expect(body.target).toMatchObject({ thread: { mode: "subject" } });
    });

    it("in a team workspace, the thread picker lists the team's threads (Review Focus 3)", () => {
      scopeTeamId = "t_platform";
      render(<AutomationWizard open onOpenChange={() => {}} preselectedPlace={INCIDENTS} />);
      clickNext();
      openRunsIn();
      fireEvent.click(screen.getByRole("radio", { name: "An existing thread…" }));
      expect(screen.getByText("Thread picker for t_platform")).toBeTruthy();
      expect(screen.queryByText("Thread picker for user")).toBeNull();
    });

    it("a service-wide place names no filter", () => {
      render(<AutomationWizard open onOpenChange={() => {}} preselectedPlace={{ subject: "slack:T1", service: "slack", label: "Slack" }} />);
      clickNext();
      expect(screen.queryByRole("button", { name: /^Remove / })).toBeNull();
    });

    it("a place outside Slack opens on the notification and never offers a Slack channel picker", () => {
      render(<AutomationWizard open onOpenChange={() => {}} preselectedPlace={ACME_API} />);
      expect((screen.getByLabelText("Something happens on GitHub") as HTMLInputElement).checked).toBe(true);
      expect((screen.getByLabelText("Work on it") as HTMLInputElement).checked).toBe(true);
      expect(screen.queryByLabelText("Someone mentions Valet in Slack")).toBeNull();
      expect(screen.queryByLabelText("Reply")).toBeNull();
      expect(screen.queryByLabelText(/Follow a Slack thread/)).toBeNull();
      clickNext();
      expect(screen.queryByLabelText("Channel id")).toBeNull();
      expect(screen.queryByRole("checkbox", { name: /slack\./ })).toBeNull();
      expect(screen.getByRole("checkbox", { name: /github\.check_run\.completed/ })).toBeTruthy();
    });

    it("keeps the place filter when the reader changes events", () => {
      render(<AutomationWizard open onOpenChange={() => {}} preselectedPlace={ACME_API} />);
      clickNext();
      fireEvent.click(screen.getByRole("checkbox", { name: /github\.check_run\.completed/ }));
      expect(screen.getByDisplayValue("acme/api")).toBeTruthy();
      // The next event has no repository field, so the filter cannot ride it.
      fireEvent.click(screen.getByRole("checkbox", { name: /github\.check_run\.completed/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
      expect(screen.queryByDisplayValue("acme/api")).toBeNull();
      // Back to an event that has the field: the place's filter returns.
      fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
      fireEvent.click(screen.getByRole("checkbox", { name: /github\.check_run\.completed/ }));
      expect(screen.getByDisplayValue("acme/api")).toBeTruthy();
      clickNext();
      clickNext();
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Failed checks" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
      expect(body.filters).toEqual([{ field: "repo", op: "eq", value: "acme/api", label: "acme/api" }]);
    });
  });

  it("a preselected workflow opens on the workflow outcome and posts that workflow", () => {
    workflowsData = { workflows: [{ id: "wf_1", name: "Deploy" }, { id: "wf_2", name: "Triage" }] };
    render(<AutomationWizard open onOpenChange={() => {}} preselectedWorkflowId="wf_2" />);
    const run = screen.getByLabelText("Run a workflow") as HTMLInputElement;
    expect(run.checked).toBe(true);
    expect((screen.getByLabelText("Work on it") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText("Reply") as HTMLInputElement).disabled).toBe(true);
    pickOutcome(GITHUB);
    expect(run.checked).toBe(true);
    expect(preview()).toBe("When something happens on GitHub, run Triage.");
    clickNext();
    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    clickNext();
    expect((screen.getByLabelText("Workflow") as HTMLSelectElement).value).toBe("wf_2");
    clickNext();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Triage PRs" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
    expect(body.target).toEqual({ kind: "workflow", workflowId: "wf_2" });
  });

  it("opens a routine with a preselected workflow on the schedule outcome", () => {
    workflowsData = { workflows: [{ id: "wf_1", name: "Deploy" }, { id: "wf_2", name: "Triage" }] };
    render(<AutomationWizard open onOpenChange={() => {}} preselectedWorkflowId="wf_2" startOn="routine" />);
    // The schedule step opens first.
    expect(screen.getByText(/Schedule$/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Cron"), { target: { value: "0 9 * * *" } });
    clickNext();
    expect((screen.getByLabelText("Workflow") as HTMLSelectElement).value).toBe("wf_2");
  });

  it("names its flow: Listen for… for an event, New routine for a schedule", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);
    expect(screen.getByRole("dialog", { name: "Listen for…" })).toBeTruthy();
    expect(screen.getByText("Choose when Valet acts and what it does.")).toBeTruthy();
    expect(screen.getByRole("group", { name: "When" })).toBeTruthy();
    pickOutcome(/On a schedule/);
    expect(screen.getByRole("dialog", { name: "New routine" })).toBeTruthy();
    clickNext();
    fireEvent.change(screen.getByLabelText("Cron"), { target: { value: "0 9 * * *" } });
    clickNext();
    fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Daily digest" } });
    clickNext();
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
    expect(screen.getByLabelText("Routine name")).toBeTruthy();
  });

  it("an event ends on Create", () => {
    render(<AutomationWizard open onOpenChange={() => {}} />);
    pickWhenDo(GITHUB, "Work on it");
    clickNext();
    fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
    clickNext();
    clickNext();
    expect(screen.getByRole("button", { name: "Create" })).toBeTruthy();
    expect(screen.queryByText(/automation|trigger|subscription/i)).toBeNull();
  });

  it("a clean create still closes the dialog", () => {
    const onOpenChange = vi.fn();
    createSubscription.mockImplementation(
      (_body: unknown, handlers: { onSuccess: (resp: object) => void }) => {
        handlers.onSuccess({ id: "sub_new" });
      },
    );
    render(<AutomationWizard open onOpenChange={onOpenChange} />);
    createReplyRule("Clean rule");
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
  describe("When and Do (spec Part H)", () => {
    const INCIDENTS = { subject: "slack:T1/C900", service: "slack" as const, label: "#incidents" };

    it("opened from #incidents, the preview reads the default line before any field is touched (Review Focus 4)", () => {
      render(<AutomationWizard open onOpenChange={() => {}} preselectedPlace={INCIDENTS} />);
      const preview = screen.getByTestId("wizard-preview");
      expect(preview.getAttribute("aria-live")).toBe("polite");
      expect(preview.textContent).toBe("When someone mentions Valet in #incidents, reply in a new thread.");
      fireEvent.click(screen.getByLabelText("Work on it"));
      expect(preview.textContent).toBe("When someone mentions Valet in #incidents, work in its own thread.");
    });

    it("a place fixes When to its service", () => {
      render(<AutomationWizard open onOpenChange={() => {}} preselectedPlace={INCIDENTS} />);
      const when = within(screen.getByRole("group", { name: "When" }));
      const radios = when.getAllByRole("radio");
      expect(radios.map((r) => r.parentElement?.textContent)).toEqual(["Someone mentions Valet in Slack"]);
      expect((radios[0] as HTMLInputElement).checked).toBe(true);
      const todo = within(screen.getByRole("group", { name: "Do" }));
      expect(todo.getAllByRole("radio").map((r) => r.parentElement?.textContent)).toEqual([
        "Reply", "Follow a Slack thread", "Work on it", "Run a workflow",
      ]);
    });

    it("an unplaced wizard offers every When choice and hides Do for a schedule", () => {
      render(<AutomationWizard open onOpenChange={() => {}} />);
      const when = within(screen.getByRole("group", { name: "When" }));
      expect(when.getAllByRole("radio").map((r) => r.parentElement?.textContent)).toEqual([
        "Someone mentions Valet in Slack", "Something happens on GitHub", "Something happens in Linear", "On a schedule",
      ]);
      fireEvent.click(screen.getByLabelText(GITHUB));
      const todo = within(screen.getByRole("group", { name: "Do" }));
      expect(todo.getAllByRole("radio").map((r) => r.parentElement?.textContent)).toEqual(["Work on it", "Run a workflow"]);
      expect((screen.getByLabelText("Work on it") as HTMLInputElement).checked).toBe(true);
      fireEvent.click(screen.getByLabelText("On a schedule"));
      expect(screen.queryByRole("group", { name: "Do" })).toBeNull();
    });

    it.each([
      ["Someone mentions Valet in Slack", "Reply", "Step 2 of 3 — Reply"],
      ["Someone mentions Valet in Slack", "Follow a Slack thread", "Step 2 of 4 — What"],
      ["Someone mentions Valet in Slack", "Work on it", "Step 2 of 4 — What"],
      ["Something happens on GitHub", "Run a workflow", "Step 2 of 4 — What"],
      ["On a schedule", undefined, "Step 2 of 4 — Schedule"],
    ])("%s + %s leads to %s", (when, todo, header) => {
      workflowsData = { workflows: [{ id: "wf_1", name: "Deploy" }] };
      render(<AutomationWizard open onOpenChange={() => {}} />);
      pickWhenDo(when, todo);
      expect(screen.getByText(/^Step 1 of \d — When$/)).toBeTruthy();
      clickNext();
      expect(screen.getByText(header)).toBeTruthy();
    });

    it("maps each pair onto the stored outcome", () => {
      workflowsData = { workflows: [{ id: "wf_1", name: "Deploy" }] };
      render(<AutomationWizard open onOpenChange={() => {}} />);
      // Slack + Reply: the channel picker.
      clickNext();
      expect(screen.getByLabelText("Channel id")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      // Slack + Follow: the thread link.
      pickOutcome("Follow a Slack thread");
      clickNext();
      expect(screen.getByLabelText("Slack thread link")).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      // Slack + Work on it: one Slack event, no GitHub events.
      pickOutcome("Work on it");
      clickNext();
      expect(screen.getByRole("checkbox", { name: /slack\.app_mention/ })).toBeTruthy();
      expect(screen.queryByRole("checkbox", { name: /github\./ })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      // GitHub + Run a workflow: GitHub events, then a workflow target.
      pickWhenDo(GITHUB, "Run a workflow");
      expect(preview()).toBe("When something happens on GitHub, run Deploy.");
      clickNext();
      expect(screen.queryByRole("checkbox", { name: /slack\./ })).toBeNull();
      fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
      clickNext();
      expect((screen.getByLabelText("Workflow") as HTMLSelectElement).value).toBe("wf_1");
      expect(screen.queryByLabelText(/Notify your personal workspace/)).toBeNull();
    });

    it("Pick raw events opens the raw picker over every service", () => {
      render(<AutomationWizard open onOpenChange={() => {}} />);
      expect(screen.getByText("Advanced: pick events and filters").tagName).toBe("SUMMARY");
      pickAdvanced();
      clickNext();
      expect(screen.getByRole("checkbox", { name: /slack\.app_mention/ })).toBeTruthy();
      expect(screen.getByRole("checkbox", { name: /github\.pr\.opened/ })).toBeTruthy();
    });

    it("the preview text equals the review step's sentence", () => {
      render(<AutomationWizard open onOpenChange={() => {}} preselectedPlace={INCIDENTS} />);
      clickNext();
      clickNext();
      const result = within(screen.getByLabelText("Summary")).getByText("Result").nextElementSibling?.textContent;
      expect(result).toBe("When someone mentions Valet in #incidents, reply in a new thread.");
      expect(preview()).toBe(result);
    });

    it("a routine's preview names the schedule and the typed name", () => {
      render(<AutomationWizard open onOpenChange={() => {}} startOn="routine" />);
      expect(screen.getByRole("dialog", { name: "New routine" })).toBeTruthy();
      expect(preview()).toBe("On a schedule, this routine: work in its own thread.");
      fireEvent.change(screen.getByLabelText("Cron"), { target: { value: "0 9 * * 1-5" } });
      fireEvent.change(screen.getByLabelText("Timezone"), { target: { value: "UTC" } });
      clickNext();
      fireEvent.change(screen.getByLabelText("Prompt"), { target: { value: "Daily digest" } });
      clickNext();
      fireEvent.change(screen.getByLabelText("Routine name"), { target: { value: "Digest" } });
      expect(preview()).toBe("Every weekday at 9:00, Digest: work in its own thread.");
      expect(within(screen.getByLabelText("Summary")).getByText("Result").nextElementSibling?.textContent).toBe(preview());
    });

    it("Runs in reads as a sentence until Change opens the field, which then stays open", () => {
      render(<AutomationWizard open onOpenChange={() => {}} preselectedPlace={INCIDENTS} />);
      clickNext();
      expect(screen.getByText("Runs in: A new thread each time")).toBeTruthy();
      expect(screen.queryByRole("group", { name: "Runs in" })).toBeNull();
      openRunsIn();
      expect(screen.getByRole("group", { name: "Runs in" })).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
      fireEvent.click(screen.getByRole("radio", { name: "Its own thread" }));
      expect(preview()).toBe("When someone mentions Valet in #incidents, work in its own thread.");
      clickNext();
      fireEvent.click(screen.getByRole("button", { name: "Back" }));
      expect(screen.getByRole("group", { name: "Runs in" })).toBeTruthy();
    });

    it("Appears as sits behind a disclosure and feeds the preview", () => {
      render(<AutomationWizard open onOpenChange={() => {}} preselectedPlace={INCIDENTS} />);
      clickNext();
      clickNext();
      const summary = screen.getAllByText("Appears as").find((el) => el.tagName === "SUMMARY");
      expect(summary?.parentElement?.tagName).toBe("DETAILS");
      fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Incident bot" } });
      expect(preview()).toBe("When someone mentions Valet in #incidents, reply in a new thread, as Incident bot.");
    });
  });

  describe("the preview equals the stored line's sentence", () => {
    const INCIDENTS = { subject: "slack:T1/C900", service: "slack" as const, label: "#incidents" };

    function expectStoredSentence() {
      const body = createSubscription.mock.calls[0][0] as CreateEventSubscriptionRequest;
      expect(presenceSentence(storedLine(body), sentenceCatalog, workflowsData.workflows, {})).toBe(preview());
    }

    it("for a reply", () => {
      render(<AutomationWizard open onOpenChange={() => {}} preselectedPlace={INCIDENTS} />);
      clickNext();
      addReplyChannel("C123");
      clickNext();
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Replies" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      expectStoredSentence();
    });

    it("for Work on it", () => {
      render(<AutomationWizard open onOpenChange={() => {}} />);
      pickWhenDo(GITHUB, "Work on it");
      clickNext();
      fireEvent.click(screen.getByRole("checkbox", { name: /github\.check_run\.completed/ }));
      clickNext();
      clickNext();
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Checks" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      expectStoredSentence();
    });

    it("for Run a workflow", () => {
      workflowsData = { workflows: [{ id: "wf_1", name: "Deploy" }] };
      render(<AutomationWizard open onOpenChange={() => {}} />);
      pickWhenDo(GITHUB, "Run a workflow");
      clickNext();
      fireEvent.click(screen.getByRole("checkbox", { name: /github\.pr\.opened/ }));
      clickNext();
      clickNext();
      fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Deploy PRs" } });
      fireEvent.click(screen.getByRole("button", { name: "Create" }));
      expectStoredSentence();
    });
  });

  it("a preselected workflow disables Pick raw events", () => {
    workflowsData = { workflows: [{ id: "wf_2", name: "Triage" }] };
    render(<AutomationWizard open onOpenChange={() => {}} preselectedWorkflowId="wf_2" />);
    expect((screen.getByRole("button", { name: "Pick raw events" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
