// @vitest-environment jsdom
/**
 * `/code-review`: the workspace's code review lines with their settings,
 * Add repository creating a PR review line with a repo condition, and the
 * ongoing reviews with links to the pull request and the review conversation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { CodeReviewWire, EventSubscriptionWire, GetReposResponse, PluginSummary } from "@valet/api/wire";
import { TooltipProvider } from "~/components/primitives";

let activeTeamId: string | undefined;
vi.mock("~/lib/workspace-scope", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/lib/workspace-scope")>(),
  useWorkspaceScope: () => ({ key: activeTeamId ?? "user", teamId: activeTeamId }),
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params }: { children: ReactNode; to: string; params?: Record<string, string> }) => (
    <a href={Object.entries(params ?? {}).reduce((path, [k, v]) => path.replace(`$${k}`, v), to)}>{children}</a>
  ),
  useSearch: () => ({}),
  createFileRoute: () => (config: unknown) => config,
}));

const plugins: PluginSummary[] = [{
  name: "pr-review",
  displayName: "PR review",
  version: "0.1.0",
  actionCount: 0,
  services: [],
  eventHandlers: [{
    id: "review-pull-request",
    description: "Review each push.",
    events: ["github.pull_request.opened", "github.pull_request.synchronize"],
    configSchema: { type: "object", properties: { minSeverity: { anyOf: [{ const: "low" }, { const: "medium" }, { const: "high" }], default: "low" } } },
  }],
}];

function reviewLine(id: string, repo: string, over: Partial<EventSubscriptionWire> = {}): EventSubscriptionWire {
  return {
    id, name: `Code review: ${repo}`, ownerType: "user", ownerId: "u-1", eventKeys: ["github.pull_request.opened"],
    filters: [{ field: "repo", op: "eq", value: repo }],
    target: { kind: "plugin", plugin: "pr-review", handler: "review-pull-request" },
    enabled: true, createdBy: "u-1", createdAt: 1, updatedAt: 1, ...over,
  };
}

let subscriptions: EventSubscriptionWire[] = [];
let reviews: CodeReviewWire[] = [];
let reposLoading = false;
let reposError: Error | null = null;
let subscriptionsLoading = false;
let subscriptionsError: Error | null = null;
const create = vi.fn((_body: unknown, opts?: { onSuccess?: (resp: { id: string }) => void }) => opts?.onSuccess?.({ id: "l-new" }));
const patch = vi.fn();
const reviewsQuery = vi.fn((_teamId?: string) => ({ data: { reviews }, isLoading: false, error: null }));

vi.mock("~/api/integrations", () => ({
  usePlugins: () => ({ data: { plugins }, isLoading: false, error: null }),
}));
vi.mock("~/api/events", () => ({
  useEventSubscriptions: () => ({ data: { subscriptions }, isLoading: subscriptionsLoading, error: subscriptionsError }),
  useCreateEventSubscription: () => ({ mutate: create, isPending: false, error: null }),
  usePatchEventSubscription: () => ({ mutate: patch, isPending: false, error: null }),
  useDeleteEventSubscription: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock("~/api/code-review", () => ({
  useCodeReviews: (teamId?: string) => reviewsQuery(teamId),
}));
const initialReposData: GetReposResponse = {
  connected: true,
  installed: true,
  repos: [
    { fullName: "acme/site", url: "https://github.com/acme/site", cloneUrl: "https://github.com/acme/site.git", defaultBranch: "main", private: true },
    { fullName: "acme/api", url: "https://github.com/acme/api", cloneUrl: "https://github.com/acme/api.git", defaultBranch: "main", private: true },
  ],
};
let reposData = initialReposData;
vi.mock("~/api/repos", () => ({
  useRepos: () => ({ data: reposData, isLoading: reposLoading, error: reposError }),
}));
vi.mock("~/api/settings", () => ({
  useMe: () => ({ data: { id: "u-1" }, isLoading: false, error: null }),
  useTeams: () => ({ data: { teams: [] }, isLoading: false, error: null }),
  useOrg: () => ({ data: { callerRole: "member", features: { organizations: false } }, isLoading: false, error: null }),
}));

import { CodeReviewPage } from "./code-review";
import { WorkspaceScopeProvider } from "~/lib/workspace-scope";

function renderPage() {
  return render(<TooltipProvider><WorkspaceScopeProvider><CodeReviewPage /></WorkspaceScopeProvider></TooltipProvider>);
}

beforeEach(() => {
  subscriptions = [];
  reviews = [];
  activeTeamId = undefined;
  reposData = initialReposData;
  reposLoading = false;
  reposError = null;
  subscriptionsLoading = false;
  subscriptionsError = null;
  create.mockClear();
  patch.mockClear();
  reviewsQuery.mockClear();
});

describe("CodeReviewPage", () => {
  it("lists accessible review configurations and saves this workspace's settings", () => {
    subscriptions = [
      reviewLine("l-site", "acme/site", { target: { kind: "plugin", plugin: "pr-review", handler: "review-pull-request", config: { minSeverity: "high" } } }),
      reviewLine("l-team", "acme/api", { ownerType: "team", ownerId: "team-1" }),
      { ...reviewLine("l-other", "acme/web"), target: { kind: "assistant" } },
    ];
    renderPage();
    const list = screen.getByRole("region", { name: "Repositories" });
    expect(within(list).getByText("acme/site")).toBeTruthy();
    expect(within(list).getByText("acme/api")).toBeTruthy();
    expect(within(list).getByRole("link", { name: "Open configuration" }).getAttribute("href")).toBe("/presence/rules/l-team");
    expect(within(list).queryByText("acme/web")).toBeNull();

    fireEvent.click(within(list).getByRole("button", { name: "Settings" }));
    expect((screen.getByLabelText("Min severity") as HTMLSelectElement).value).toBe("high");
    fireEvent.change(screen.getByLabelText("Min severity"), { target: { value: "low" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(patch).toHaveBeenCalledWith({ id: "l-site", body: { config: null } }, expect.anything());

    fireEvent.click(screen.getByRole("switch", { name: "Review pull requests in acme/site" }));
    expect(patch).toHaveBeenCalledWith({ id: "l-site", body: { enabled: false } }, expect.anything());
  });

  it("shows installed repositories with review off and creates one scoped configuration when enabled", () => {
    activeTeamId = "team-1";
    reposData = { ...initialReposData, repos: initialReposData.repos.map((repo) => ({ ...repo, installed: repo.fullName === "acme/site" })) };
    renderPage();
    const list = screen.getByRole("region", { name: "Repositories" });
    expect(within(list).getByText("acme/site")).toBeTruthy();
    expect(within(list).getByText("GitHub App installed. Code review is off.")).toBeTruthy();
    expect(within(list).queryByText("acme/api")).toBeNull();
    const toggle = within(list).getByRole("switch", { name: "Review pull requests in acme/site" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(create).toHaveBeenCalledOnce();
    expect(create).toHaveBeenCalledWith({
      name: "Code review: acme/site",
      eventKeys: ["github.pull_request.opened", "github.pull_request.synchronize"],
      filters: [{ field: "repo", op: "eq", value: "acme/site" }],
      target: { kind: "plugin", plugin: "pr-review", handler: "review-pull-request", teamId: "team-1" },
    }, expect.anything());
    expect(reviewsQuery).toHaveBeenCalledWith("team-1");
  });

  it("shows a personal configuration from a team view without creating or changing it", () => {
    activeTeamId = "team-1";
    subscriptions = [reviewLine("personal-line", "acme/site")];
    renderPage();
    const list = screen.getByRole("region", { name: "Repositories" });
    expect(within(list).getByText("acme/site")).toBeTruthy();
    expect(within(list).getByText(/Personal workspace/)).toBeTruthy();
    expect(within(list).getByRole("link", { name: "Open configuration" }).getAttribute("href")).toBe("/presence/rules/personal-line");
    const toggle = within(list).getByRole("switch", { name: "Review pull requests in acme/site" });
    expect(toggle.hasAttribute("disabled")).toBe(true);
    fireEvent.click(toggle);
    expect(create).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
    expect(within(list).queryByRole("button", { name: "Settings" })).toBeNull();
  });

  it("keeps an existing configuration manageable when GitHub no longer lists the repository", () => {
    reposData = { ...initialReposData, repos: [] };
    subscriptions = [reviewLine("old-line", "acme/old")];
    renderPage();
    const list = screen.getByRole("region", { name: "Repositories" });
    expect(within(list).getByText("acme/old")).toBeTruthy();
    fireEvent.click(within(list).getByRole("button", { name: "Settings" }));
    expect(screen.getByLabelText("Min severity")).toBeTruthy();
  });

  it("does not list repositories without App access or an existing configuration", () => {
    renderPage();
    const list = screen.getByRole("region", { name: "Repositories" });
    expect(within(list).queryByText("acme/site")).toBeNull();
    expect(within(list).queryByText("acme/api")).toBeNull();
    expect(within(list).getByText(/No installed repositories or review configurations/)).toBeTruthy();
  });

  it("orders configured repositories first, then installed repositories alphabetically", () => {
    reposData = { ...initialReposData, repos: initialReposData.repos.map((repo) => ({ ...repo, installed: true })) };
    subscriptions = [reviewLine("off-line", "aa/off", { enabled: false }), reviewLine("on-line", "zz/review")];
    renderPage();
    const list = screen.getByRole("region", { name: "Repositories" });
    expect(within(list).getAllByRole("switch").map((toggle) => toggle.getAttribute("aria-label"))).toEqual([
      "Review pull requests in zz/review", "Review pull requests in aa/off", "Review pull requests in acme/api", "Review pull requests in acme/site",
    ]);
  });

  it("filters the repository list with a distinct search field and visible counts", () => {
    reposData = { ...initialReposData, repos: initialReposData.repos.map((repo) => ({ ...repo, installed: true })) };
    renderPage();
    const list = screen.getByRole("region", { name: "Repositories" });
    fireEvent.change(within(list).getByRole("searchbox", { name: "Filter repositories" }), { target: { value: "API" } });
    expect(within(list).getByText("acme/api")).toBeTruthy();
    expect(within(list).queryByText("acme/site")).toBeNull();
    expect(within(list).getByText("Showing 1 of 2 repositories.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
    expect(within(screen.getByRole("dialog")).getByRole("searchbox", { name: "Search repositories" })).toBeTruthy();
  });

  it("lists each repository once and prefers its current workspace configuration", () => {
    activeTeamId = "team-1";
    reposData = { ...initialReposData, repos: initialReposData.repos.map((repo) => ({ ...repo, installed: true })) };
    subscriptions = [reviewLine("personal-line", "ACME/SITE"), reviewLine("team-line", "acme/site", { ownerType: "team", ownerId: "team-1" })];
    renderPage();
    const list = screen.getByRole("region", { name: "Repositories" });
    expect(within(list).getAllByText("acme/site")).toHaveLength(1);
    fireEvent.click(within(list).getByRole("switch", { name: "Review pull requests in acme/site" }));
    expect(patch).toHaveBeenCalledWith({ id: "team-line", body: { enabled: false } }, expect.anything());
    expect(create).not.toHaveBeenCalled();
  });

  it("discards a personal row's draft when switching to another workspace's configuration for the same repository", () => {
    subscriptions = [
      reviewLine("personal-line", "acme/site", { target: { kind: "plugin", plugin: "pr-review", handler: "review-pull-request", config: { minSeverity: "low" } } }),
      reviewLine("team-line", "acme/site", { ownerType: "team", ownerId: "team-1", target: { kind: "plugin", plugin: "pr-review", handler: "review-pull-request", config: { minSeverity: "high" } } }),
    ];
    const page = renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    fireEvent.change(screen.getByLabelText("Min severity"), { target: { value: "medium" } });
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(false);
    activeTeamId = "team-1";
    page.rerender(<TooltipProvider><WorkspaceScopeProvider><CodeReviewPage /></WorkspaceScopeProvider></TooltipProvider>);
    expect(screen.queryByLabelText("Min severity")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect((screen.getByLabelText("Min severity") as HTMLSelectElement).value).toBe("high");
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);
    expect(patch).not.toHaveBeenCalled();
  });

  it("uses broad foreign configurations for installed repositories instead of adding duplicates", () => {
    activeTeamId = "team-1";
    reposData = { ...initialReposData, repos: initialReposData.repos.map((repo) => ({ ...repo, installed: true })) };
    subscriptions = [reviewLine("broad-line", "acme/*", { filters: [{ field: "repo", op: "prefix", value: "acme/" }] })];
    renderPage();
    const list = screen.getByRole("region", { name: "Repositories" });
    expect(within(list).getAllByRole("link", { name: "Open configuration" })).toHaveLength(2);
    for (const toggle of within(list).getAllByRole("switch")) {
      expect(toggle.hasAttribute("disabled")).toBe(true);
      fireEvent.click(toggle);
    }
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps a shared current configuration read-only on each repository and links to its full settings", () => {
    reposData = { ...initialReposData, repos: initialReposData.repos.map((repo) => ({ ...repo, installed: true })) };
    subscriptions = [reviewLine("shared-line", "acme/*", { filters: [{ field: "repo", op: "in", value: ["acme/site", "acme/api"] }] })];
    renderPage();
    const list = screen.getByRole("region", { name: "Repositories" });
    expect(within(list).getAllByText(/Shared configuration. Changes apply to all repositories it covers./)).toHaveLength(2);
    const links = within(list).getAllByRole("link", { name: "Open configuration" });
    expect(links.map((link) => link.getAttribute("href"))).toEqual(["/presence/rules/shared-line", "/presence/rules/shared-line"]);
    for (const toggle of within(list).getAllByRole("switch")) {
      expect(toggle.hasAttribute("disabled")).toBe(true);
      fireEvent.click(toggle);
    }
    expect(within(list).queryByRole("button", { name: "Settings" })).toBeNull();
    expect(patch).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("waits for review configurations before enabling installed repositories", () => {
    subscriptionsLoading = true;
    reposData = { ...initialReposData, repos: initialReposData.repos.map((repo) => ({ ...repo, installed: true })) };
    renderPage();
    const list = screen.getByRole("region", { name: "Repositories" });
    expect(within(list).getByText("Loading repositories…")).toBeTruthy();
    expect(within(list).queryByRole("switch")).toBeNull();
  });

  it("shows an actionable repository error while keeping known configurations available", () => {
    reposError = new Error("unavailable");
    subscriptions = [reviewLine("site-line", "acme/site")];
    renderPage();
    const list = screen.getByRole("region", { name: "Repositories" });
    expect(within(list).getByText(/Valet cannot load GitHub repositories/)).toBeTruthy();
    expect(within(list).getByRole("button", { name: "Settings" })).toBeTruthy();
  });

  it("adds a repository as a PR review line with a repo condition", () => {
    subscriptions = [reviewLine("l-site", "acme/site")];
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("button", { name: /acme\/site/ })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: /acme\/api/ }));
    expect(create).toHaveBeenCalledWith({
      name: "Code review: acme/api",
      eventKeys: ["github.pull_request.opened", "github.pull_request.synchronize"],
      filters: [{ field: "repo", op: "eq", value: "acme/api" }],
      target: { kind: "plugin", plugin: "pr-review", handler: "review-pull-request" },
    }, expect.anything());
  });

  it("opens existing repository settings without creating another review line", () => {
    subscriptions = [reviewLine("l-site", "acme/site")];
    renderPage();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: /acme\/site/ }));
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(screen.getByLabelText("Min severity")).toBeTruthy();
      expect(create).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Settings" }));
      expect(screen.queryByLabelText("Min severity")).toBeNull();
    }
  });

  it("groups an open pull request with its ongoing review chain and conversation", () => {
    reviews = [{
      repo: "acme/site", number: 7, title: "Fix checkout retries", url: "https://github.com/acme/site/pull/7", state: "open", status: "complete",
      reviewId: 41, head: "abc1234def", openFindings: 2, resolvedFindings: 1, updatedAt: Date.now(), threadId: "t-7",
      rounds: [
        { head: "111aaaa", mode: "full", at: "2026-11-04T12:00:00Z", newFindings: 3, resolved: 0 },
        { head: "abc1234def", mode: "incremental", at: "2026-11-05T12:00:00Z", newFindings: 0, resolved: 1 },
      ],
    }];
    renderPage();
    const ongoing = screen.getByRole("region", { name: "Ongoing reviews" });
    expect(within(ongoing).getByRole("link", { name: "acme/site#7" }).getAttribute("href")).toBe("https://github.com/acme/site/pull/7#pullrequestreview-41");
    expect(within(ongoing).getByRole("link", { name: "Open conversation" }).getAttribute("href")).toBe("/threads/t-7");
    expect(within(ongoing).getByText("Fix checkout retries")).toBeTruthy();
    expect(within(ongoing).getByText(/2 open findings, 1 fixed/)).toBeTruthy();
    fireEvent.click(within(ongoing).getByRole("button", { name: "Review chain (2)" }));
    expect(within(ongoing).getByText("Full review")).toBeTruthy();
    expect(within(ongoing).getByText("Incremental review")).toBeTruthy();
    expect(within(ongoing).getByRole("link", { name: "111aaaa" }).getAttribute("href")).toBe("https://github.com/acme/site/commit/111aaaa");
    expect(within(ongoing).getByText(/0 new findings, 1 fixed/)).toBeTruthy();
  });

  it("shows a first review while it runs before any completed rounds exist", () => {
    reviews = [{
      repo: "acme/api", number: 8, title: "Add billing export", url: "https://github.com/acme/api/pull/8", state: "open", status: "running",
      openFindings: 0, resolvedFindings: 0, updatedAt: Date.now(), rounds: [],
    }];
    renderPage();
    const ongoing = screen.getByRole("region", { name: "Ongoing reviews" });
    expect(within(ongoing).getByText("Reviewing…")).toBeTruthy();
    expect(within(ongoing).getByRole("link", { name: "acme/api#8" })).toBeTruthy();
    expect(within(ongoing).queryByRole("button", { name: /Review chain/ })).toBeNull();
    expect(within(ongoing).getByText("Waiting for the first review result.")).toBeTruthy();
  });

  it("says so when the deployment has no PR review plugin", () => {
    const saved = plugins.splice(0);
    try {
      renderPage();
      expect(screen.getByText(/Code review is not installed on this deployment/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: "Add repository" })).toBeNull();
    } finally {
      plugins.push(...saved);
    }
  });
});
