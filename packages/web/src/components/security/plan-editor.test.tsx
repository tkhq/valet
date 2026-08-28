// @vitest-environment jsdom
/**
 * Planning-phase step editor (dynamic-config M-F2, spec §Dynamic
 * configuration): it renders `planCells` for a planning admin, add/remove/
 * reorder mutate local state, Save posts the structured cells, and it is
 * hidden once the engagement runs or for a non-admin.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  GetSessionResponse,
  GetSessionSecurityResponse,
  ListSecurityFindingsResponse,
  SecurityPlanCellInput,
  SecurityPlanCellWire,
  SecuritySetPlanResponse,
} from "@valet/api/wire";
import { TooltipProvider } from "~/components/primitives";

const getSessionMock = vi.fn<(id: string) => Promise<GetSessionResponse>>();
const getSecurityMock = vi.fn<(id: string) => Promise<GetSessionSecurityResponse>>();
const listFindingsMock = vi.fn<() => Promise<ListSecurityFindingsResponse>>();
const setPlanCellsMock =
  vi.fn<(id: string, cells: SecurityPlanCellInput[]) => Promise<SecuritySetPlanResponse>>();

vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getSession: (id: string) => getSessionMock(id),
      getSessionSecurity: (id: string) => getSecurityMock(id),
      listSecurityFindings: () => listFindingsMock(),
      setSecurityPlanCells: (id: string, cells: SecurityPlanCellInput[]) =>
        setPlanCellsMock(id, cells),
    },
  };
});

const meMock = vi.fn(() => ({ data: { id: "u-1", orgRole: "member" }, isLoading: false, error: null }));
// Type teams explicitly so an override can supply a team; a bare `[]` infers
// `never[]` and rejects `{ id, callerRole }`.
const teamsMock = vi.fn<
  () => { data: { teams: Array<{ id: string; callerRole: string }> }; isLoading: boolean; error: null }
>(() => ({ data: { teams: [] }, isLoading: false, error: null }));
vi.mock("~/api/settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/settings")>();
  return { ...actual, useMe: () => meMock(), useTeams: () => teamsMock() };
});

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useNavigate: () => () => undefined,
}));

import { EngagementPanel } from "./engagement-panel";

const PLAN_CELLS: SecurityPlanCellWire[] = [
  { ordinal: 1, persona: "code-review", name: "recon", goal: "Map the tree", reads: [], review: false },
  {
    ordinal: 2,
    persona: "code-review",
    name: "authz",
    goal: "Sweep authz",
    playbook: "authz",
    reads: [1],
    review: false,
  },
];

const planningSecurity: GetSessionSecurityResponse = {
  engagement: {
    id: "eng-1",
    sessionId: "s-1",
    status: "planning",
    repoFullName: "acme/site",
    repoRef: "",
    plan: "cells: []",
    baseRef: null,
    changedPaths: null,
    hasRepoConfig: false,
    focus: null,
    invariants: null,
    categories: null,
    configPersonas: null,
    configTools: null,
    createdAt: 1,
    updatedAt: 2,
  },
  planCells: PLAN_CELLS,
  cells: [],
  cost: { costUsd: 0, totalTokens: 0, priced: true },
};

const session: GetSessionResponse = {
  id: "s-1",
  workspace: "acme/site",
  status: "active",
  kind: "security",
  runState: "idle",
  createdAt: 1,
  updatedAt: 2,
  lastActivityAt: 2,
  owner: { type: "user", id: "u-1" },
  messageCount: 0,
  profile: "headless",
  docker: false,
};

beforeEach(() => {
  getSessionMock.mockResolvedValue(session);
  getSecurityMock.mockResolvedValue(planningSecurity);
  listFindingsMock.mockResolvedValue({ findings: [], nextCursor: null });
  setPlanCellsMock.mockReset();
  setPlanCellsMock.mockResolvedValue({ cellCount: 2 });
  meMock.mockReturnValue({ data: { id: "u-1", orgRole: "member" }, isLoading: false, error: null });
  teamsMock.mockReturnValue({ data: { teams: [] }, isLoading: false, error: null });
});

function renderPanel() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <EngagementPanel sessionId="s-1" />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("PlanEditor", () => {
  it("renders planCells as editable steps for a planning admin", async () => {
    renderPanel();
    const editor = await screen.findByTestId("plan-editor");
    const steps = within(editor).getAllByTestId("plan-step");
    expect(steps).toHaveLength(2);
    // Each step's goal is an editable field seeded from planCells.
    expect((within(steps[0]).getByLabelText("Goal") as HTMLTextAreaElement).value).toBe(
      "Map the tree",
    );
    expect((within(steps[1]).getByLabelText("Goal") as HTMLTextAreaElement).value).toBe(
      "Sweep authz",
    );
  });

  it("adds and removes a step in local state", async () => {
    renderPanel();
    const editor = await screen.findByTestId("plan-editor");
    fireEvent.click(within(editor).getByRole("button", { name: "Add step" }));
    expect(within(editor).getAllByTestId("plan-step")).toHaveLength(3);

    fireEvent.click(within(editor).getByRole("button", { name: "Remove step 3" }));
    expect(within(editor).getAllByTestId("plan-step")).toHaveLength(2);
  });

  it("reorders steps with move up", async () => {
    renderPanel();
    const editor = await screen.findByTestId("plan-editor");
    // Move step 2 up: its goal now leads.
    fireEvent.click(within(editor).getByRole("button", { name: "Move step 2 up" }));
    const steps = within(editor).getAllByTestId("plan-step");
    expect((within(steps[0]).getByLabelText("Goal") as HTMLTextAreaElement).value).toBe(
      "Sweep authz",
    );
  });

  it("posts the structured cells on Save", async () => {
    renderPanel();
    const editor = await screen.findByTestId("plan-editor");
    fireEvent.click(within(editor).getByRole("button", { name: "Save plan" }));
    await vi.waitFor(() => expect(setPlanCellsMock).toHaveBeenCalledTimes(1));
    const [, cells] = setPlanCellsMock.mock.calls[0];
    expect(cells).toHaveLength(2);
    expect(cells[0]).toMatchObject({ persona: "code-review", goal: "Map the tree", reads: [] });
    expect(cells[1]).toMatchObject({ persona: "code-review", goal: "Sweep authz", reads: [1] });
  });

  it("shows an inline error when a step has no goal and blocks Save", async () => {
    renderPanel();
    const editor = await screen.findByTestId("plan-editor");
    const firstGoal = within(within(editor).getAllByTestId("plan-step")[0]).getByLabelText(
      "Goal",
    );
    fireEvent.change(firstGoal, { target: { value: "" } });
    expect(within(editor).getByTestId("plan-error")).toBeTruthy();
    const save = within(editor).getByRole("button", { name: "Save plan" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
  });

  it("hides the editor once the engagement is running", async () => {
    getSecurityMock.mockResolvedValue({
      ...planningSecurity,
      engagement: { ...planningSecurity.engagement, status: "running" },
    });
    renderPanel();
    await screen.findByText("acme/site");
    expect(screen.queryByTestId("plan-editor")).toBeNull();
  });

  it("hides the editor for a non-admin on a team-owned engagement", async () => {
    getSessionMock.mockResolvedValue({ ...session, owner: { type: "team", id: "team-1" } });
    teamsMock.mockReturnValue({
      data: { teams: [{ id: "team-1", callerRole: "member" }] },
      isLoading: false,
      error: null,
    });
    renderPanel();
    await screen.findByText("acme/site");
    expect(screen.queryByTestId("plan-editor")).toBeNull();
  });
});
