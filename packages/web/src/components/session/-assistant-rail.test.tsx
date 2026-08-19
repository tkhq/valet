// @vitest-environment jsdom
/**
 * The `/chat` sidebar lists every assistant the caller can reach, grouped by
 * owner. The cases that matter most are the ones where it must render
 * NOTHING extra: a solo user with one assistant, and an org with the
 * organizations feature turned off, must both see exactly the sidebar they
 * saw before a principal could own several. Empty scaffolding for a feature
 * you do not have is worse than no feature.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  AssistantSummary,
  ListAssistantsResponse,
  ListTeamsResponse,
  MeResponse,
  NotificationSummary,
  OrgResponse,
  TeamSummary,
} from "@valet/api/wire";

let teamsData: ListTeamsResponse | undefined = { teams: [] };
let orgData: OrgResponse | undefined;
let meData: MeResponse | undefined;
let assistantsData: ListAssistantsResponse | undefined = { assistants: [] };
let assistantsError: Error | null = null;
let searchParams: { assistant?: string } = {};

function RouterLinkStub({
  to,
  search,
  children,
  className,
}: {
  to: string;
  search?: Record<string, string | undefined>;
  children: ReactNode;
  className?: string;
}) {
  const params = Object.entries(search ?? {}).filter(
    (entry): entry is [string, string] => entry[1] !== undefined,
  );
  const qs = params.length > 0 ? `?${new URLSearchParams(params).toString()}` : "";
  return (
    <a href={`${to}${qs}`} className={className}>
      {children}
    </a>
  );
}

vi.mock("@tanstack/react-router", () => ({
  Link: RouterLinkStub,
  useSearch: () => searchParams,
  useNavigate: () => vi.fn(),
}));

vi.mock("~/api/settings", () => ({
  useTeams: () => ({ data: teamsData, isLoading: false, error: null }),
  useOrg: () => ({ data: orgData, isLoading: false, error: null }),
  useMe: () => ({ data: meData, isLoading: false, error: null }),
}));

// importOriginal, not a bare replacement: `vitest.config.ts` sets
// `isolate: false`, so an incomplete factory in one file can end up governing
// the module for other files sharing the worker. Spreading the real module
// keeps every export present.
const createMutate = vi.fn();
vi.mock("~/api/assistants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/assistants")>();
  return {
    ...actual,
    useAssistants: () => ({
      data: assistantsData,
      isLoading: false,
      error: assistantsError,
    }),
    useCreateAssistant: () => ({ mutate: createMutate, isPending: false, error: null }),
    usePatchAssistant: () => ({ mutate: vi.fn(), isPending: false, error: null }),
    useArchiveAssistant: () => ({ mutate: vi.fn(), isPending: false, error: null }),
  };
});

vi.mock("~/api/orchestrator", () => ({
  useOrchestratorInfo: () => ({
    data: { sessionId: "assistant:asst_own", name: "Aurora" },
    isLoading: false,
    error: null,
  }),
  useOrchestratorChildren: () => ({ data: { children: [] }, refetch: vi.fn() }),
}));

// The rail marks a row when that assistant is waiting on an answer, reading
// the notifications the bell already polls. Swappable per test so the
// attention cases can drive it.
let notifications: NotificationSummary[] = [];
vi.mock("~/api/queries", () => ({
  useNotifications: () => ({ data: { notifications }, isLoading: false, error: null }),
}));

// The thread list is covered by its own suite; stub it so these cases are
// about the Assistants block alone.
vi.mock("./thread-tree", () => ({
  ThreadTree: ({ sessionId }: { sessionId?: string }) => (
    <div data-testid="thread-tree" data-session={sessionId ?? "own"} />
  ),
}));

import { TooltipProvider } from "~/components/primitives";
import { AssistantRail, eligibleTeams } from "./assistant-rail";
import { WorkspaceScopeProvider } from "~/lib/workspace-scope";

/** Team rows carry a "shared with N people" tooltip, so the rail needs the
 * provider its real parent (`AppShell`) supplies. */
function renderRail() {
  // The rail reads the workspace scope rather than re-deriving it from the
  // open assistant. The provider is the real one — it runs on the same
  // mocked `useSearch`/`useAssistants`/`useTeams` these tests already set,
  // so `searchParams.assistant` still decides the workspace exactly as
  // before, and these cases keep testing the rail rather than a stub.
  return render(
    <TooltipProvider>
      <WorkspaceScopeProvider>
        <AssistantRail />
      </WorkspaceScopeProvider>
    </TooltipProvider>,
  );
}

function team(over: Partial<TeamSummary> = {}): TeamSummary {
  return {
    id: "team_1",
    orgId: "org_1",
    name: "Platform",
    origin: "local",
    externalId: null,
    createdAt: 1,
    memberCount: 3,
    callerRole: "member",
    ...over,
  };
}

function org(organizations: boolean): OrgResponse {
  return {
    id: "org_1",
    name: "Acme",
    createdAt: 0,
    ssoTeamGroups: [],
    callerRole: "member",
    features: { organizations, ssoTeamSync: false },
  };
}

function me(orgRole: "admin" | "member" = "member"): MeResponse {
  return {
    id: "u1",
    email: "member@example.com",
    name: "Member",
    avatarUrl: null,
    role: "member",
    orgId: "org_1",
    orgRole,
    defaultModel: null,
    modelPreferences: [],
  };
}

function mine(over: Partial<AssistantSummary> = {}): AssistantSummary {
  return {
    id: "asst_own",
    owner: { type: "user", id: "u1" },
    name: "Aurora",
    sessionId: "assistant:asst_own",
    isDefault: true,
    createdAt: 1,
    ...over,
  };
}

function teamAssistant(over: Partial<AssistantSummary> = {}): AssistantSummary {
  return {
    id: "asst_team",
    owner: { type: "team", id: "team_1" },
    name: "Triage",
    sessionId: "assistant:asst_team",
    isDefault: true,
    createdAt: 2,
    ...over,
  };
}

beforeEach(() => {
  // The workspace scope persists, and jsdom shares localStorage across a
  // file. Without this, whichever test last selected a team would decide the
  // starting workspace of every test after it.
  window.localStorage.clear();
  teamsData = { teams: [] };
  orgData = org(true);
  meData = me();
  assistantsData = { assistants: [mine()] };
  assistantsError = null;
  notifications = [];
  searchParams = {};
  createMutate.mockClear();
});

describe("eligibleTeams", () => {
  it("drops every team when the organizations feature is off", () => {
    expect(eligibleTeams([team()], false)).toEqual([]);
  });

  it("drops teams the caller only administers as an org admin", () => {
    // `GET /api/teams` returns every org team to an org admin, with
    // callerRole null for the ones they are not on. Those are not the
    // caller's assistants.
    expect(eligibleTeams([team({ callerRole: null })], true)).toEqual([]);
  });

  it("keeps teams the caller belongs to", () => {
    expect(eligibleTeams([team()], true)).toHaveLength(1);
  });

  it("returns nothing while the org query is unresolved", () => {
    expect(eligibleTeams([team()], undefined)).toEqual([]);
  });
});

describe("AssistantRail", () => {
  it("renders no Assistants block for a solo user with one assistant", () => {
    // One row switches nothing, so the block is not drawn at all.
    renderRail();
    expect(screen.queryByText("Your assistants")).toBeNull();
    expect(screen.getByTestId("thread-tree")).toBeTruthy();
  });

  it("renders no Assistants block when the organizations feature is off", () => {
    orgData = org(false);
    teamsData = { teams: [team()] };
    assistantsData = { assistants: [mine(), teamAssistant()] };
    renderRail();
    expect(screen.queryByText("Your assistants")).toBeNull();
    expect(screen.queryByText("Platform")).toBeNull();
  });

  it("renders nothing until every query resolves, rather than flashing", () => {
    orgData = undefined;
    teamsData = { teams: [team()] };
    assistantsData = { assistants: [mine(), teamAssistant()] };
    renderRail();
    expect(screen.queryByText("Your assistants")).toBeNull();
  });

  it("renders nothing until the assistants list resolves", () => {
    assistantsData = undefined;
    teamsData = { teams: [team()] };
    renderRail();
    expect(screen.queryByText("Your assistants")).toBeNull();
  });

  it("names the corrective action when the list cannot be loaded", () => {
    assistantsError = new Error("network");
    renderRail();
    expect(screen.getByText("Cannot load your assistants. Reload the page.")).toBeTruthy();
  });

  it("draws only the active workspace, not every owner at once", () => {
    teamsData = { teams: [team(), team({ id: "team_2", name: "Design" })] };
    assistantsData = {
      assistants: [
        mine(),
        teamAssistant(),
        teamAssistant({ id: "asst_design", owner: { type: "team", id: "team_2" }, name: "Roadmap" }),
      ],
    };
    renderRail();
    // Nothing open means your own workspace. The other owners exist and are
    // reachable, but through the switcher beside the logo — not by stacking
    // every owner's rows into one column, which is what made the block grow
    // with the number of teams.
    expect(screen.getByText("Your assistants")).toBeTruthy();
    expect(screen.getByText("Aurora")).toBeTruthy();
    expect(screen.queryByText("Platform")).toBeNull();
    expect(screen.queryByText("Design")).toBeNull();
  });

  it("draws the team's workspace when one of its assistants is open", () => {
    teamsData = { teams: [team(), team({ id: "team_2", name: "Design" })] };
    assistantsData = {
      assistants: [
        mine(),
        teamAssistant(),
        teamAssistant({ id: "asst_design", owner: { type: "team", id: "team_2" }, name: "Roadmap" }),
      ],
    };
    searchParams = { assistant: "asst_team" };
    renderRail();
    expect(screen.getByText("Platform")).toBeTruthy();
    expect(screen.getByText("Triage")).toBeTruthy();
    // The workspace you are not in stays out of the column entirely.
    expect(screen.queryByText("Your assistants")).toBeNull();
    expect(screen.queryByText("Design")).toBeNull();
  });

  /** The rule that changed: one principal, many assistants. The rail used to
   * derive one session id per team and could show no more than one row. */
  it("lists every assistant a single team owns", () => {
    teamsData = { teams: [team()] };
    assistantsData = {
      assistants: [
        mine(),
        teamAssistant(),
        teamAssistant({ id: "asst_release", name: "Release", isDefault: false }),
      ],
    };
    searchParams = { assistant: "asst_team" };
    renderRail();
    expect(screen.getByText("Triage")).toBeTruthy();
    expect(screen.getByText("Release")).toBeTruthy();
  });

  it("links each row to its own assistant id and clears the previous thread", () => {
    teamsData = { teams: [team()] };
    assistantsData = {
      assistants: [mine(), teamAssistant({ id: "asst_release", name: "Release" })],
    };
    searchParams = { assistant: "asst_release" };
    renderRail();
    const link = screen.getByRole("link", { name: /Release/ });
    expect(link.getAttribute("href")).toBe("/chat?assistant=asst_release");
  });

  it("marks the workspace's default assistant, and only it", () => {
    teamsData = { teams: [team()] };
    assistantsData = {
      assistants: [
        mine(),
        teamAssistant(),
        teamAssistant({ id: "asst_release", name: "Release", isDefault: false }),
      ],
    };
    searchParams = { assistant: "asst_team" };
    renderRail();
    // One workspace is drawn, so one default is marked. Your own default is
    // not on screen to be confused with the team's.
    expect(screen.getAllByText("Default")).toHaveLength(1);
  });

  it("shows your own default's threads when no assistant is selected", () => {
    teamsData = { teams: [team()] };
    assistantsData = { assistants: [mine(), teamAssistant()] };
    renderRail();
    expect(screen.getByTestId("thread-tree").getAttribute("data-session")).toBe(
      "assistant:asst_own",
    );
  });

  it("shows the selected assistant's threads when ?assistant= names one you can reach", () => {
    teamsData = { teams: [team()] };
    assistantsData = { assistants: [mine(), teamAssistant()] };
    searchParams = { assistant: "asst_team" };
    renderRail();
    expect(screen.getByTestId("thread-tree").getAttribute("data-session")).toBe(
      "assistant:asst_team",
    );
  });

  it("falls back to your own default when ?assistant= names one you cannot reach", () => {
    teamsData = { teams: [team()] };
    assistantsData = { assistants: [mine(), teamAssistant()] };
    searchParams = { assistant: "asst_nope" };
    renderRail();
    expect(screen.getByTestId("thread-tree").getAttribute("data-session")).toBe(
      "assistant:asst_own",
    );
  });

  it("falls back to your own default when ?assistant= names a team you left", () => {
    // The team is gone from `GET /api/teams`, so its assistant has no group
    // and cannot be opened, even though the id is real.
    assistantsData = { assistants: [mine(), teamAssistant()] };
    searchParams = { assistant: "asst_team" };
    renderRail();
    expect(screen.getByTestId("thread-tree").getAttribute("data-session")).toBe(
      "assistant:asst_own",
    );
  });

  it("offers a new assistant for each owner you may administer", () => {
    teamsData = { teams: [team({ callerRole: "admin" })] };
    assistantsData = { assistants: [mine(), teamAssistant()] };
    renderRail();
    // Only the open workspace is drawn, so only its create action exists.
    expect(screen.getByRole("button", { name: "New assistant for Your assistants" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New assistant for Platform" })).toBeNull();
  });

  it("hides the team's create and row actions from a plain member", () => {
    teamsData = { teams: [team({ callerRole: "member" })] };
    assistantsData = { assistants: [mine(), teamAssistant()] };
    searchParams = { assistant: "asst_team" };
    renderRail();
    expect(screen.queryByRole("button", { name: "New assistant for Platform" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Triage actions" })).toBeNull();
  });

  it("creates an assistant for the owner whose action was used", async () => {
    const user = userEvent.setup();
    teamsData = { teams: [team({ callerRole: "admin" })] };
    assistantsData = { assistants: [mine(), teamAssistant()] };
    searchParams = { assistant: "asst_team" };
    renderRail();
    await user.click(screen.getByRole("button", { name: "New assistant for Platform" }));
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0]?.[0]).toEqual({ owner: { type: "team", id: "team_1" } });
  });

  it("keeps rename and archive behind the row menu", async () => {
    const user = userEvent.setup();
    teamsData = { teams: [team()] };
    assistantsData = {
      assistants: [mine(), mine({ id: "asst_second", name: "Scratch", isDefault: false })],
    };
    renderRail();
    expect(screen.queryByText("Rename")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Scratch actions" }));
    expect(screen.getByText("Rename")).toBeTruthy();
    expect(screen.getByText("Archive")).toBeTruthy();
    expect(screen.getByText("Make default")).toBeTruthy();
  });

  it("says how to unblock archiving the default rather than failing on the server", async () => {
    const user = userEvent.setup();
    assistantsData = {
      assistants: [mine(), mine({ id: "asst_second", name: "Scratch", isDefault: false })],
    };
    renderRail();
    await user.click(screen.getByRole("button", { name: "Aurora actions" }));
    expect(screen.getByText("Make another assistant the default first.")).toBeTruthy();
  });

  it("marks an assistant that is waiting on you", () => {
    teamsData = { teams: [team()] };
    assistantsData = { assistants: [mine(), teamAssistant()] };
    notifications = [
      {
        id: "n1",
        kind: "question",
        urgency: "high",
        title: "Which branch?",
        sessionId: "assistant:asst_team",
        createdAt: 1,
      },
    ];
    searchParams = { assistant: "asst_team" };
    renderRail();
    expect(screen.getByLabelText("Waiting on you")).toBeTruthy();
  });
});
