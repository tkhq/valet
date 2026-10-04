// @vitest-environment jsdom
/**
 * The subscriptions panel asks for the workspace the nav's switcher names
 * (small-fixes design, decisions 1 and 2). These cases pin the OWNER the list
 * requests. The Log's own scope cases live in `event-log.test.tsx`.
 *
 * `~/api/events` is mocked to record the arguments its hooks receive,
 * following the same isolate-from-the-network pattern as the page suite in
 * `routes/-events.test.tsx`.
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type {
  EventSubscriptionWire,
  TeamSummary,
  WorkflowDefinitionSummary,
} from "@valet/api/wire";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnerFilter } from "~/api/client";
import { TooltipProvider } from "~/components/primitives";

function subscription(over: Partial<EventSubscriptionWire> = {}): EventSubscriptionWire {
  return {
    id: "sub_1",
    name: "PR alerts",
    ownerType: "user",
    ownerId: "u1",
    eventKeys: ["github.pr.opened"],
    filters: [],
    target: { kind: "orchestrator" as const },
    enabled: true,
    createdBy: "u1",
    createdAt: 1,
    updatedAt: 1,
    ...over,
  };
}

function teamFixture(over: Partial<TeamSummary> = {}): TeamSummary {
  return {
    id: "t_eng",
    orgId: "org_1",
    name: "Engineering",
    origin: "local",
    externalId: null,
    createdAt: 1,
    memberCount: 3,
    callerRole: "member",
    defaultModel: null,
    ...over,
  };
}

/** The rows the mocked list answers with; reassigned per case, reset in
 * `beforeEach`. */
let subscriptionsData: { subscriptions: EventSubscriptionWire[] } = {
  subscriptions: [subscription()],
};

const catalogData = {
  services: [
    {
      service: "github",
      entries: [{ key: "github.pr.opened", description: "A pull request was opened", filters: [] }],
    },
  ],
};


/** The owner each hook was last called with. `undefined` is a real answer
 * here — it is what an unscoped list sends — so a separate "was it called"
 * flag keeps the two apart. */
let subscriptionsOwner: OwnerFilter | undefined;
/** Whether the subscriptions query was allowed to run on the last render. */
let subscriptionsEnabled: boolean | undefined;
const openAssistant = vi.fn();
vi.mock("~/components/layout/workspace-assistant", () => ({ useWorkspaceAssistant: () => ({ open: openAssistant }) }));

vi.mock("~/api/events", () => ({
  useEventCatalog: () => ({ data: catalogData, isLoading: false, error: null }),
  useEventSubscriptions: (owner?: OwnerFilter, opts?: { enabled?: boolean }) => {
    subscriptionsOwner = owner;
    subscriptionsEnabled = opts?.enabled;
    // A held query has no data, which is what react-query answers while
    // `enabled` is false.
    const held = opts?.enabled === false;
    return {
      data: held ? undefined : subscriptionsData,
      isPending: held,
      error: null,
    };
  },
  usePatchEventSubscription: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateEventSubscription: () => ({ mutate: vi.fn(), isPending: false }),
  useDeleteEventSubscription: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));

/** The workflow rows a workflow-target subscription resolves its assistant
 * through. Mutable per case, reset in `beforeEach`. */
let workflowsData: { workflows: WorkflowDefinitionSummary[] } = { workflows: [] };
vi.mock("~/api/workflows", () => ({
  useWorkflows: () => ({ data: workflowsData, isLoading: false, error: null }),
}));

// The assistant badge links to the assistant editor, and the real `Link`
// wants a router this suite has no reason to mount. `params` is serialized
// so a case can read the assistant a badge navigates to.
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    ...rest
  }: {
    children: ReactNode;
    params?: unknown;
    [key: string]: unknown;
  }) => (
    <a data-params={JSON.stringify(params)} data-search={JSON.stringify(rest.search)} {...rest}>
      {children}
    </a>
  ),
}));

// The caller's identity, mutable per case: undefined is the frame before
// `useMe` lands, which is what the panel's scope gate has to survive.
let meId: string | undefined = "u1";
// Whether `useMe` has FAILED rather than being in flight. `useListOwner`
// answers undefined for both, so this flag is the only thing that tells a
// hold that ends from a hold that does not.
let meFailed = false;
/** The teams the caller can see. A team badge names one of these when its
 * assistant cannot be resolved. Mutable per case, reset in `beforeEach`. */
let teamsData: { teams: TeamSummary[] } = { teams: [] };
vi.mock("~/api/settings", () => ({
  useMe: () => ({
    data: meId === undefined ? undefined : { id: meId, orgRole: "member" },
    isLoading: meId === undefined && !meFailed,
    isError: meFailed,
    error: meFailed ? new Error("identity unavailable") : null,
  }),
  useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
  useOrg: () => ({ data: { features: { organizations: true } }, isLoading: false, error: null }),
}));

// The switcher's key, mutable per case; reset in afterEach.
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

import { SubscriptionsPanel } from "./subscriptions-panel";

beforeEach(() => {
  subscriptionsOwner = undefined;
  subscriptionsData = { subscriptions: [subscription()] };
  workflowsData = { workflows: [] };
  teamsData = { teams: [] };
  openAssistant.mockClear();
});

afterEach(() => {
  scopeTeamId = undefined;
  meId = "u1";
  meFailed = false;
});

describe("SubscriptionsPanel", () => {
  it("opens assistant setup with a paused proposal request", () => {
    render(<TooltipProvider><SubscriptionsPanel /></TooltipProvider>);
    fireEvent.click(screen.getByRole("button", { name: "Create with Valet" }));
    expect(openAssistant).toHaveBeenCalledTimes(1);
    expect(openAssistant).toHaveBeenCalledWith(expect.stringContaining("save a paused proposal for me to review before enabling it"));
  });

  it("resets the organization filter when the workspace changes", () => {
    subscriptionsData = { subscriptions: [
      subscription({ id: "org", name: "Org watch", ownerType: "org", ownerId: "org_1" }),
      subscription({ id: "team", name: "Team watch", ownerType: "team", ownerId: "t_eng" }),
      subscription(),
    ] };
    const view = render(<TooltipProvider><SubscriptionsPanel /></TooltipProvider>);
    expect(screen.getByText("PR alerts")).toBeTruthy();
    expect(screen.queryByText("Team watch")).toBeNull();
    fireEvent.change(screen.getByLabelText("Subscription scope"), { target: { value: "organization" } });
    expect(screen.getByText("Org watch")).toBeTruthy();
    expect(screen.queryByText("PR alerts")).toBeNull();
    scopeTeamId = "t_eng";
    view.rerender(<TooltipProvider><SubscriptionsPanel /></TooltipProvider>);
    expect((screen.getByLabelText("Subscription scope") as HTMLSelectElement).value).toBe("workspace");
    expect(screen.getByText("Team watch")).toBeTruthy();
    expect(screen.queryByText("Org watch")).toBeNull();
    expect(screen.queryByText("PR alerts")).toBeNull();
  });

  it("asks for the caller's own subscriptions in the personal workspace", () => {
    render(
      <TooltipProvider>
        <SubscriptionsPanel />
      </TooltipProvider>,
    );
    expect(subscriptionsOwner).toEqual({ ownerType: "user", ownerId: "u1" });
  });

  it("asks for the team's subscriptions in a team workspace", () => {
    scopeTeamId = "t_eng";
    render(
      <TooltipProvider>
        <SubscriptionsPanel />
      </TooltipProvider>,
    );
    expect(subscriptionsOwner).toEqual({ ownerType: "team", ownerId: "t_eng" });
  });

  it("says who may mention each team assistant rule", () => {
    scopeTeamId = "t_eng";
    subscriptionsData = {
      subscriptions: [
        subscription({
          id: "sub_open",
          name: "Open replies",
          ownerType: "team",
          ownerId: "t_eng",
          eventKeys: ["slack.app_mention"],
          filters: [{ field: "channel", op: "eq", value: "C1", label: "#eng" }],
          target: { kind: "orchestrator", orchestrator: "team", teamId: "t_eng" },
          audience: "organization",
        }),
        subscription({
          id: "sub_closed",
          name: "Team replies",
          ownerType: "team",
          ownerId: "t_eng",
          eventKeys: ["slack.app_mention"],
          filters: [{ field: "channel", op: "eq", value: "C2", label: "#ops" }],
          target: { kind: "orchestrator", orchestrator: "team", teamId: "t_eng" },
        }),
      ],
    };
    render(
      <TooltipProvider>
        <SubscriptionsPanel />
      </TooltipProvider>,
    );
    expect(screen.getByText(/org members/)).toBeTruthy();
    expect(screen.getByText(/team only/)).toBeTruthy();
  });

  // The header names the active workspace, so the list must not show the
  // whole org for the frame before `useMe` lands. The Log holds the same way.
  it("holds the list until the workspace owner resolves", () => {
    meId = undefined;
    render(
      <TooltipProvider>
        <SubscriptionsPanel />
      </TooltipProvider>,
    );
    expect(subscriptionsOwner).toBeUndefined();
    expect(subscriptionsEnabled).toBe(false);
    expect(screen.queryByText("PR alerts")).toBeNull();
    expect(screen.getByText("Loading subscriptions…")).toBeTruthy();
  });

  // A permanent `useMe` failure resolves no owner ever, so the hold has no
  // end: without a terminal state the tab reads "Loading subscriptions…"
  // for the length of the session.
  it("reports a failed identity instead of holding for ever", () => {
    meId = undefined;
    meFailed = true;
    render(
      <TooltipProvider>
        <SubscriptionsPanel />
      </TooltipProvider>,
    );
    expect(screen.queryByText("Loading subscriptions…")).toBeNull();
    // The tab has no unscoped state to offer, so the message names the one
    // move the reader has.
    expect(
      screen.getByText(/subscriptions cannot be listed for it\. Reload the page to try again\./),
    ).toBeTruthy();
  });

  // The API includes organization rules. The explicit filter keeps them
  // manageable without mixing them into workspace-owned rules.
  it("shows an org-owned subscription only after selecting Organization rules in the personal workspace", () => {
    subscriptionsData = {
      subscriptions: [subscription({ id: "sub_org", name: "Org watch", ownerType: "org", ownerId: "org_1" })],
    };
    render(
      <TooltipProvider>
        <SubscriptionsPanel />
      </TooltipProvider>,
    );
    expect(screen.queryByText("Org watch")).toBeNull();
    fireEvent.change(screen.getByLabelText("Subscription scope"), { target: { value: "organization" } });
    expect(screen.getByText("Org watch")).toBeTruthy();
    expect(screen.getByText("Org")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Disable Org watch" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
  });

  it("shows an org-owned subscription only after selecting Organization rules in a team workspace", () => {
    scopeTeamId = "t_eng";
    subscriptionsData = {
      subscriptions: [subscription({ id: "sub_org", name: "Org watch", ownerType: "org", ownerId: "org_1" })],
    };
    render(
      <TooltipProvider>
        <SubscriptionsPanel />
      </TooltipProvider>,
    );
    expect(screen.queryByText("Org watch")).toBeNull();
    fireEvent.change(screen.getByLabelText("Subscription scope"), { target: { value: "organization" } });
    expect(screen.getByText("Org watch")).toBeTruthy();
    expect(screen.getByText("Org")).toBeTruthy();
    const toggle = screen.getByRole("switch", { name: "Disable Org watch" }) as HTMLButtonElement;
    expect(toggle.disabled).toBe(false);
  });

  // Mention scoping (TKAI-299): a mention row must say whether it listens in
  // named channels or everywhere. A non-mention row says neither.
  it("labels a mention subscription's channel scope, named or any", () => {
    subscriptionsData = {
      subscriptions: [
        subscription({
          id: "sub_named",
          name: "Named",
          eventKeys: ["slack.app_mention"],
          filters: [
            { field: "channel", op: "eq", value: "C1", label: "#eng" },
            { field: "user", op: "eq", value: "U1" },
          ],
        }),
        subscription({
          id: "sub_any",
          name: "Anywhere",
          eventKeys: ["slack.app_mention"],
          filters: [{ field: "user", op: "eq", value: "U1" }],
        }),
      ],
    };
    render(
      <TooltipProvider>
        <SubscriptionsPanel />
      </TooltipProvider>,
    );
    expect(screen.getByText(/only #eng/)).toBeTruthy();
    expect(screen.getByText(/any channel/)).toBeTruthy();
  });

  // The row badges the assistant that answers the event, not the team that
  // owns the rule: a team has many assistants, and the badge is the way in
  // to the one this rule uses.
  it("links a team target to its workspace conversation", () => {
    scopeTeamId = "t_eng";
    teamsData = { teams: [teamFixture()] };
    subscriptionsData = {
      subscriptions: [
        subscription({
          ownerType: "team",
          ownerId: "t_eng",
          target: { kind: "orchestrator", orchestrator: "team", teamId: "t_eng" },
        }),
      ],
    };
    render(
      <TooltipProvider>
        <SubscriptionsPanel />
      </TooltipProvider>,
    );

    const link = screen.getByText("Engineering").closest("a");
    expect(link?.getAttribute("to")).toBe("/chat");
    expect(JSON.parse(link?.getAttribute("data-search") ?? "null")).toEqual({
      workspace: "t_eng",
    });
    // The badge names the assistant, not the owning team it used to name.
    // "Engineering" survives in the target clause, which is a sentence, not
    // a badge.
    expect(screen.queryByText("Release Captain")).toBeNull();
  });

  // `GET /api/assistants` does not list org-owned assistants today, so the
  // row prints "Org" itself. The day the route lists them, the assistant
  // badge names the org and the plain word must step aside: one "Org", not
  // two.
  it("prints one Org label when the org's assistant resolves (forward guard)", () => {
    subscriptionsData = {
      subscriptions: [
        subscription({
          ownerType: "org",
          ownerId: "org_1",
          target: { kind: "orchestrator", orchestrator: "org" },
        }),
      ],
    };
    render(
      <TooltipProvider>
        <SubscriptionsPanel />
      </TooltipProvider>,
    );

    fireEvent.change(screen.getByLabelText("Subscription scope"), { target: { value: "organization" } });
    const labels = screen.getAllByText("Org");
    expect(labels).toHaveLength(1);
    expect(labels[0].closest("a")).toBeNull();
  });

  // Everything on a personal page belongs to the reader, so a badge naming
  // their own default assistant carries no information.
  it("says nothing about a personal rule its reader's default assistant answers", () => {
    const { container } = render(
      <TooltipProvider>
        <SubscriptionsPanel />
      </TooltipProvider>,
    );

    expect(screen.getByText("PR alerts")).toBeTruthy();
    expect(container.querySelector('a[to="/assistants/$assistantId"]')).toBeNull();
  });
});
