// @vitest-environment jsdom
/**
 * The `/chat` sidebar lists every assistant the caller can reach. The cases
 * that matter most are the ones where it must render NOTHING extra: a solo
 * user with no teams, and an org with the organizations feature turned off,
 * must both see exactly the sidebar they saw before teams existed. Empty
 * scaffolding for a feature you do not have is worse than no feature.
 */
import type { ReactNode } from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import type { ListTeamsResponse, OrgResponse, TeamSummary } from "@valet/api/wire";

let teamsData: ListTeamsResponse | undefined = { teams: [] };
let orgData: OrgResponse | undefined;
let searchParams: { team?: string } = {};

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
}));

vi.mock("~/api/orchestrator", () => ({
  useOrchestratorInfo: () => ({
    data: { sessionId: "orchestrator:user:u1", name: "Aurora" },
    isLoading: false,
    error: null,
  }),
  useOrchestratorChildren: () => ({ data: { children: [] }, refetch: vi.fn() }),
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

/** Team rows carry a "shared with N people" tooltip, so the rail needs the
 * provider its real parent (`AppShell`) supplies. */
function renderRail() {
  return render(
    <TooltipProvider>
      <AssistantRail />
    </TooltipProvider>,
  );
}

function team(over: Partial<TeamSummary> = {}): TeamSummary {
  return {
    id: "team_1",
    orgId: "org_1",
    name: "Platform",
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
    callerRole: "member",
    features: { organizations },
  };
}

beforeEach(() => {
  teamsData = { teams: [] };
  orgData = org(true);
  searchParams = {};
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
  it("renders no Assistants block for a user with no teams", () => {
    renderRail();
    expect(screen.queryByText("Assistants")).toBeNull();
    expect(screen.getByTestId("thread-tree")).toBeTruthy();
  });

  it("renders no Assistants block when the organizations feature is off", () => {
    orgData = org(false);
    teamsData = { teams: [team()] };
    renderRail();
    expect(screen.queryByText("Assistants")).toBeNull();
  });

  it("renders nothing until both queries resolve, rather than flashing", () => {
    orgData = undefined;
    teamsData = { teams: [team()] };
    renderRail();
    expect(screen.queryByText("Assistants")).toBeNull();
  });

  it("lists your assistant and each team you belong to", () => {
    teamsData = { teams: [team(), team({ id: "team_2", name: "Design" })] };
    renderRail();
    expect(screen.getByText("Assistants")).toBeTruthy();
    expect(screen.getByText("Aurora")).toBeTruthy();
    expect(screen.getByText("Platform")).toBeTruthy();
    expect(screen.getByText("Design")).toBeTruthy();
  });

  it("links each team row to its assistant and clears the previous thread", () => {
    teamsData = { teams: [team()] };
    renderRail();
    const link = screen.getByRole("link", { name: /Platform/ });
    expect(link.getAttribute("href")).toBe("/chat?team=team_1");
  });

  it("shows your own threads when no team is selected", () => {
    teamsData = { teams: [team()] };
    renderRail();
    expect(screen.getByTestId("thread-tree").getAttribute("data-session")).toBe("own");
  });

  it("shows the selected team's threads when ?team= names a team you are on", () => {
    teamsData = { teams: [team()] };
    searchParams = { team: "team_1" };
    renderRail();
    expect(screen.getByTestId("thread-tree").getAttribute("data-session")).toBe(
      "orchestrator:team:team_1",
    );
  });

  it("falls back to your own threads when ?team= names a team you cannot reach", () => {
    teamsData = { teams: [team()] };
    searchParams = { team: "team_nope" };
    renderRail();
    expect(screen.getByTestId("thread-tree").getAttribute("data-session")).toBe("own");
  });
});
