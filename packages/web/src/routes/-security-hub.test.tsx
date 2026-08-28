// @vitest-environment jsdom
/**
 * `/security` hub (valet-security M7): the "New review" card refuses to
 * start without a repo, Start POSTs `kind: "security"` with the repo
 * binding and navigates to the created session, and the list below renders
 * each `kind=security` session with its engagement's status badge.
 * Router mocked the same way `-workflows.index.test.tsx` does — this suite
 * cares that navigation was requested, not that the router resolved it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type {
  CreateSessionRequest,
  GetReposResponse,
  GetSessionSecurityResponse,
  SessionSummary,
} from "@valet/api/wire";
import { TooltipProvider } from "~/components/primitives";

const reviewsData: { sessions: SessionSummary[] } = { sessions: [] };

const engagementsBySession: Record<string, GetSessionSecurityResponse> = {
  s_1: {
    engagement: {
      id: "seng_1",
      sessionId: "s_1",
      status: "running",
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
      authorizedScope: null,
      createdAt: 1,
      updatedAt: 2,
    },
    cells: [],
    cost: { costUsd: 0, totalTokens: 0, priced: true },
    planCells: [],
  },
};

const reposData: GetReposResponse = {
  connected: true,
  installed: false,
  repos: [
    {
      fullName: "acme/site",
      url: "https://github.com/acme/site",
      cloneUrl: "https://github.com/acme/site.git",
      defaultBranch: "main",
      private: false,
    },
  ],
};

const navigate = vi.fn();
const createMutateAsync = vi.fn().mockResolvedValue({ id: "s_new" });
// The re-scan mutation: calls onSuccess with the created session, mirroring
// useMutation's `mutate(vars, { onSuccess })` contract.
const rescanMutate = vi.fn(
  (_vars: unknown, opts?: { onSuccess?: (data: { id: string }) => void }) => {
    opts?.onSuccess?.({ id: "s_rescan" });
  },
);

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children: ReactNode; [key: string]: unknown }) => (
    <a {...rest}>{children}</a>
  ),
  useNavigate: () => navigate,
  // The workspace scope reads `?assistant=`; this page never renders with
  // one, so the search is always empty.
  useSearch: () => ({}),
  createFileRoute: () => (config: unknown) => config,
}));

vi.mock("~/api/queries", () => ({
  useCreateSession: () => ({ mutateAsync: createMutateAsync, isPending: false, error: null }),
}));

vi.mock("~/api/security", () => ({
  useSecurityReviews: () => ({ data: reviewsData, isLoading: false, error: null }),
  useEngagement: (sessionId: string) => ({
    data: engagementsBySession[sessionId],
    isLoading: false,
    error: null,
  }),
  useRescanReview: () => ({ mutate: rescanMutate, isPending: false, error: null }),
}));

vi.mock("~/api/repos", () => ({
  useRepos: () => ({ data: reposData, isLoading: false, error: null }),
}));

// The workspace scope provider reads the assistants list to let an open
// assistant win over the stored key; no assistant is open here.
vi.mock("~/api/assistants", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/api/assistants")>();
  return {
    ...actual,
    useAssistants: () => ({ data: { assistants: [] }, isLoading: false, error: null }),
  };
});

// `useListOwner` reads the caller's own id; `WorkspaceClause` reads teams +
// org features (none here, so the clause renders nothing).
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u-1" }, isLoading: false, error: null }),
  useTeams: () => ({ data: { teams: [] }, isLoading: false, error: null }),
  useOrg: () => ({ data: { features: { organizations: false } }, isLoading: false, error: null }),
  // No org catalog here, so the hub falls back to the curated MODEL_CATALOG.
  useModels: () => ({ data: undefined, isLoading: false, error: null }),
}));

import { SecurityIndexPage } from "./security.index";
import { WorkspaceScopeProvider } from "~/lib/workspace-scope";

function renderPage() {
  return render(
    <TooltipProvider>
      <WorkspaceScopeProvider>
        <SecurityIndexPage />
      </WorkspaceScopeProvider>
    </TooltipProvider>,
  );
}

function pickRepo() {
  const combobox = screen.getByRole("combobox", { name: "Search repositories" });
  fireEvent.focus(combobox);
  fireEvent.click(screen.getByRole("option", { name: /acme\/site/ }));
}

beforeEach(() => {
  window.localStorage.clear();
  reviewsData.sessions = [];
  navigate.mockClear();
  createMutateAsync.mockClear();
  rescanMutate.mockClear();
});

describe("SecurityIndexPage", () => {
  it("shows the empty state when no security reviews exist", () => {
    renderPage();
    expect(
      screen.getByText("No security reviews yet. Point one at a repository to start."),
    ).toBeTruthy();
  });

  it("renders a review row with its title, repo, and engagement status badge", () => {
    reviewsData.sessions = [
      {
        id: "s_1",
        workspace: "/workspace/site",
        status: "active",
        kind: "security",
        runState: "idle",
        title: "Token audit",
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        lastActivityAt: 1700000000000,
        owner: { type: "user", id: "u-1" },
      },
    ];
    renderPage();

    const link = screen.getByText("Token audit").closest("a");
    expect(link).toBeTruthy();
    expect(screen.getByText("acme/site")).toBeTruthy();
    expect(screen.getByText("running")).toBeTruthy();
    expect(screen.queryByText(/No security reviews yet/)).toBeNull();
    // A running engagement offers no re-scan — there is nothing to iterate on.
    expect(screen.queryByRole("button", { name: "Re-scan latest" })).toBeNull();
  });

  it("offers Re-scan latest only on a terminal engagement and starts a re-scan", () => {
    // A completed engagement for the row.
    engagementsBySession.s_done = {
      engagement: {
        id: "seng_done",
        sessionId: "s_done",
        status: "completed",
        repoFullName: "acme/site",
        repoRef: "b".repeat(40),
        plan: "cells: []",
        baseRef: null,
        changedPaths: null,
        hasRepoConfig: false,
        focus: null,
        invariants: null,
        categories: null,
        configPersonas: null,
        configTools: null,
        authorizedScope: null,
        createdAt: 1,
        updatedAt: 2,
      },
      cells: [],
      cost: { costUsd: 0, totalTokens: 0, priced: true },
      planCells: [],
    };
    reviewsData.sessions = [
      {
        id: "s_done",
        workspace: "/workspace/site",
        status: "active",
        kind: "security",
        runState: "idle",
        title: "Prior review",
        createdAt: 1700000000000,
        updatedAt: 1700000000000,
        lastActivityAt: 1700000000000,
        owner: { type: "user", id: "u-1" },
      },
    ];
    renderPage();

    const button = screen.getByRole("button", { name: "Re-scan latest" });
    fireEvent.click(button);
    expect(rescanMutate).toHaveBeenCalledTimes(1);
    expect(rescanMutate.mock.calls[0][0]).toMatchObject({ rescanOf: "s_done" });
    // onSuccess navigated to the new session.
    expect(navigate).toHaveBeenCalledWith({
      to: "/sessions/$sessionId",
      params: { sessionId: "s_rescan" },
    });
    delete engagementsBySession.s_done;
  });

  it("keeps Start disabled until a repo is picked", () => {
    renderPage();
    const start = screen.getByRole("button", { name: "Start review" }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);

    pickRepo();
    expect(start.disabled).toBe(false);
  });

  it("starts a review with kind security, the repo binding, and the prompt, then navigates", async () => {
    renderPage();
    pickRepo();
    fireEvent.change(screen.getByLabelText("Prompt (optional)"), {
      target: { value: "focus on the token minting paths" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    const body = createMutateAsync.mock.calls[0]![0] as CreateSessionRequest;
    expect(body.kind).toBe("security");
    // Host working directory, not the in-sandbox `/workspace` mount — the
    // api mkdir's this path, and `/workspace/<name>` fails on the host.
    expect(body.workspace).toBe("/tmp/valet/workspace/site");
    expect(body.repo).toEqual({
      host: "github",
      fullName: "acme/site",
      cloneUrl: "https://github.com/acme/site.git",
      ref: "main",
      auth: "auto",
    });
    expect(body.initialPrompt).toBe("focus on the token minting paths");
    // The hub always sends a model, defaulting to the capable security model.
    expect(body.model).toBe("claude-sonnet-4-6");

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({
        to: "/sessions/$sessionId",
        params: { sessionId: "s_new" },
      }),
    );
  });

  it("sends no initialPrompt when the prompt is blank", async () => {
    renderPage();
    pickRepo();
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    const body = createMutateAsync.mock.calls[0]![0] as CreateSessionRequest;
    expect(body.initialPrompt).toBeUndefined();
  });

  it("defaults the model to claude-sonnet-4-6 and sends the picked model", async () => {
    renderPage();
    pickRepo();

    const select = screen.getByLabelText("Model") as HTMLSelectElement;
    expect(select.value).toBe("claude-sonnet-4-6");

    fireEvent.change(select, { target: { value: "claude-opus-4-7" } });
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    const body = createMutateAsync.mock.calls[0]![0] as CreateSessionRequest;
    expect(body.model).toBe("claude-opus-4-7");
  });

  it("offers the three sweep presets, defaulting to full code review", () => {
    renderPage();
    const select = screen.getByLabelText("Preset") as HTMLSelectElement;
    expect(select.disabled).toBe(false);
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(["code-review", "secrets-config", "access-injection"]);
    expect(select.value).toBe("code-review");
  });

  it("sends the picked preset", async () => {
    renderPage();
    pickRepo();
    fireEvent.change(screen.getByLabelText("Preset"), { target: { value: "secrets-config" } });
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    const body = createMutateAsync.mock.calls[0]![0] as CreateSessionRequest;
    expect(body.preset).toBe("secrets-config");
  });

  it("splits the paths input into globs and omits the field when blank", async () => {
    renderPage();
    pickRepo();
    fireEvent.change(screen.getByLabelText("Scope to paths (optional)"), {
      target: { value: "packages/api, src/auth" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    const body = createMutateAsync.mock.calls[0]![0] as CreateSessionRequest;
    expect(body.paths).toEqual(["packages/api", "src/auth"]);
  });

  it("omits paths when the scope input is blank", async () => {
    renderPage();
    pickRepo();
    fireEvent.click(screen.getByRole("button", { name: "Start review" }));

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    const body = createMutateAsync.mock.calls[0]![0] as CreateSessionRequest;
    expect(body.paths).toBeUndefined();
  });

  it("starts a review against a pasted public repo with no ref (default branch)", async () => {
    renderPage();
    fireEvent.change(screen.getByLabelText("Public repository"), {
      target: { value: "https://github.com/openai/gpt-4" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    // The repo is now selected; Start is enabled.
    const start = screen.getByRole("button", { name: "Start review" }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);

    await waitFor(() => expect(createMutateAsync).toHaveBeenCalledTimes(1));
    const body = createMutateAsync.mock.calls[0]![0] as CreateSessionRequest;
    expect(body.repo).toEqual({
      host: "github",
      fullName: "openai/gpt-4",
      cloneUrl: "https://github.com/openai/gpt-4.git",
      auth: "auto",
    });
    // No ref — the server resolves the default branch HEAD.
    expect((body.repo as { ref?: string }).ref).toBeUndefined();
    expect(body.workspace).toBe("/tmp/valet/workspace/gpt-4");
  });
});
