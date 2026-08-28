// @vitest-environment jsdom
/**
 * Focus + invariants editor (dynamic-config M-F3, spec §Dynamic configuration):
 * it renders an editable form for a planning admin, Save posts the focus +
 * invariants, and it shows a read-only view once the engagement runs.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import type {
  GetSessionResponse,
  GetSessionSecurityResponse,
  ListSecurityFindingsResponse,
  SecuritySetConfigResponse,
} from "@valet/api/wire";
import { TooltipProvider } from "~/components/primitives";

const getSessionMock = vi.fn<(id: string) => Promise<GetSessionResponse>>();
const getSecurityMock = vi.fn<(id: string) => Promise<GetSessionSecurityResponse>>();
const listFindingsMock = vi.fn<() => Promise<ListSecurityFindingsResponse>>();
const setConfigMock =
  vi.fn<
    (
      id: string,
      body: { focus?: string | null; invariants?: string[]; categories?: string[] },
    ) => Promise<SecuritySetConfigResponse>
  >();

vi.mock("~/api/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/client")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getSession: (id: string) => getSessionMock(id),
      getSessionSecurity: (id: string) => getSecurityMock(id),
      listSecurityFindings: () => listFindingsMock(),
      setSecurityConfig: (
        id: string,
        body: { focus?: string | null; invariants?: string[]; categories?: string[] },
      ) => setConfigMock(id, body),
    },
  };
});

const meMock = vi.fn(() => ({ data: { id: "u-1", orgRole: "member" }, isLoading: false, error: null }));
const teamsMock = vi.fn(() => ({ data: { teams: [] }, isLoading: false, error: null }));
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
    focus: "the multi-tenant data path",
    invariants: ["every admin route sits behind requireAdmin"],
    categories: null,
    configPersonas: null,
    configTools: null,
    authorizedScope: null,
    createdAt: 1,
    updatedAt: 2,
  },
  planCells: [],
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
  setConfigMock.mockReset();
  setConfigMock.mockResolvedValue({
    focus: "the multi-tenant data path",
    invariants: ["every admin route sits behind requireAdmin"],
    categories: [],
  });
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

describe("ConfigEditor", () => {
  it("renders an editable focus + invariants form seeded from the engagement", async () => {
    renderPanel();
    const editor = await screen.findByTestId("config-editor");
    expect((within(editor).getByLabelText("Focus (optional)") as HTMLTextAreaElement).value).toBe(
      "the multi-tenant data path",
    );
    expect((within(editor).getByLabelText("Invariant 1") as HTMLInputElement).value).toBe(
      "every admin route sits behind requireAdmin",
    );
  });

  it("adds an invariant and posts focus + invariants on Save", async () => {
    renderPanel();
    const editor = await screen.findByTestId("config-editor");
    fireEvent.click(within(editor).getByRole("button", { name: "Add invariant" }));
    fireEvent.change(within(editor).getByLabelText("Invariant 2"), {
      target: { value: "tenant id is always checked in the repository layer" },
    });
    fireEvent.click(within(editor).getByRole("button", { name: "Save focus" }));

    await vi.waitFor(() => expect(setConfigMock).toHaveBeenCalledTimes(1));
    const [, body] = setConfigMock.mock.calls[0];
    expect(body.focus).toBe("the multi-tenant data path");
    expect(body.invariants).toEqual([
      "every admin route sits behind requireAdmin",
      "tenant id is always checked in the repository layer",
    ]);
  });

  it("renders the threat-category checkboxes and posts the selected ids on Save (M-P2a)", async () => {
    renderPanel();
    const editor = await screen.findByTestId("config-editor");
    const categories = within(editor).getByTestId("config-categories");
    // Toggle two categories, then Save.
    fireEvent.click(within(categories).getByLabelText("Authorization"));
    fireEvent.click(within(categories).getByLabelText("Webhooks"));
    fireEvent.click(within(editor).getByRole("button", { name: "Save focus" }));

    await vi.waitFor(() => expect(setConfigMock).toHaveBeenCalledTimes(1));
    const [, body] = setConfigMock.mock.calls[0];
    // Saved in KNOWN_CATEGORIES order, not toggle order.
    expect(body.categories).toEqual(["authz", "webhooks"]);
  });

  it("seeds the category checkboxes from the engagement (M-P2a)", async () => {
    getSecurityMock.mockResolvedValue({
      ...planningSecurity,
      engagement: { ...planningSecurity.engagement, categories: ["authz"] },
    });
    renderPanel();
    const editor = await screen.findByTestId("config-editor");
    const categories = within(editor).getByTestId("config-categories");
    expect((within(categories).getByLabelText("Authorization") as HTMLInputElement).checked).toBe(
      true,
    );
    expect((within(categories).getByLabelText("Webhooks") as HTMLInputElement).checked).toBe(false);
  });

  it("shows loaded categories read-only once running (M-P2a)", async () => {
    getSecurityMock.mockResolvedValue({
      ...planningSecurity,
      engagement: {
        ...planningSecurity.engagement,
        status: "running",
        focus: null,
        invariants: null,
        categories: ["authz", "webhooks"],
      },
    });
    renderPanel();
    const view = await screen.findByTestId("config-readonly-categories");
    expect(within(view).getByText("Authorization")).toBeTruthy();
    expect(within(view).getByText("Webhooks")).toBeTruthy();
    expect(screen.queryByTestId("config-editor")).toBeNull();
  });

  it("shows focus + invariants read-only once running", async () => {
    getSecurityMock.mockResolvedValue({
      ...planningSecurity,
      engagement: { ...planningSecurity.engagement, status: "running" },
    });
    renderPanel();
    const view = await screen.findByTestId("config-readonly");
    expect(within(view).getByTestId("config-readonly-focus").textContent).toContain(
      "the multi-tenant data path",
    );
    expect(within(view).getByText("every admin route sits behind requireAdmin")).toBeTruthy();
    // No editable form once running.
    expect(screen.queryByTestId("config-editor")).toBeNull();
  });

  it("hides the config surface entirely when running with no focus or invariants", async () => {
    getSecurityMock.mockResolvedValue({
      ...planningSecurity,
      engagement: {
        ...planningSecurity.engagement,
        status: "running",
        focus: null,
        invariants: null,
      },
    });
    renderPanel();
    await screen.findByText("acme/site");
    expect(screen.queryByTestId("config-readonly")).toBeNull();
    expect(screen.queryByTestId("config-editor")).toBeNull();
  });

  it("shows the authorized scope and declared tools for live testing (M-P4b)", async () => {
    getSecurityMock.mockResolvedValue({
      ...planningSecurity,
      engagement: {
        ...planningSecurity.engagement,
        status: "running",
        focus: null,
        invariants: null,
        authorizedScope: { hosts: ["staging.example.com", "api.staging.example.com"] },
        configTools: [
          { id: "nuclei", egress: ["staging.example.com"] },
          { id: "zap", mcp: { url: "http://127.0.0.1:8090", prefix: "mcp__zap__" } },
        ],
      },
    });
    renderPanel();
    const live = await screen.findByTestId("live-testing");
    const scope = within(live).getByTestId("live-authorized-scope");
    expect(within(scope).getByText("staging.example.com")).toBeTruthy();
    expect(within(scope).getByText("api.staging.example.com")).toBeTruthy();
    const tools = within(live).getByTestId("live-declared-tools");
    expect(within(tools).getByText(/nuclei/)).toBeTruthy();
    expect(within(tools).getByText(/zap/)).toBeTruthy();
  });
});
