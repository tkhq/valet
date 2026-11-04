// @vitest-environment jsdom
/**
 * `/code-review`: the workspace's code review lines with their settings,
 * Add repository creating a PR review line with a repo condition, and the
 * recent reviews with links to the pull request and the plugin thread.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { CodeReviewWire, EventSubscriptionWire, GetReposResponse, PluginSummary } from "@valet/api/wire";
import { TooltipProvider } from "~/components/primitives";

vi.mock("~/lib/workspace-scope", async (importOriginal) => ({
  ...await importOriginal<typeof import("~/lib/workspace-scope")>(),
  useWorkspaceScope: () => ({ key: "user", teamId: undefined }),
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
    configSchema: { type: "object", properties: { minSeverity: { anyOf: [{ const: "low" }, { const: "high" }], default: "low" } } },
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
const create = vi.fn((_body: unknown, opts?: { onSuccess?: (resp: { id: string }) => void }) => opts?.onSuccess?.({ id: "l-new" }));
const patch = vi.fn();

vi.mock("~/api/integrations", () => ({
  usePlugins: () => ({ data: { plugins }, isLoading: false, error: null }),
}));
vi.mock("~/api/events", () => ({
  useEventSubscriptions: () => ({ data: { subscriptions }, isLoading: false, error: null }),
  useCreateEventSubscription: () => ({ mutate: create, isPending: false, error: null }),
  usePatchEventSubscription: () => ({ mutate: patch, isPending: false, error: null }),
  useDeleteEventSubscription: () => ({ mutate: vi.fn(), isPending: false, error: null }),
}));
vi.mock("~/api/code-review", () => ({
  useCodeReviews: () => ({ data: { reviews }, isLoading: false, error: null }),
}));
const reposData: GetReposResponse = {
  connected: true,
  installed: true,
  repos: [
    { fullName: "acme/site", url: "https://github.com/acme/site", cloneUrl: "https://github.com/acme/site.git", defaultBranch: "main", private: true },
    { fullName: "acme/api", url: "https://github.com/acme/api", cloneUrl: "https://github.com/acme/api.git", defaultBranch: "main", private: true },
  ],
};
vi.mock("~/api/repos", () => ({
  useRepos: () => ({ data: reposData, isLoading: false, error: null }),
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
  create.mockClear();
  patch.mockClear();
});

describe("CodeReviewPage", () => {
  it("lists only this workspace's review lines and saves changed settings", () => {
    subscriptions = [
      reviewLine("l-site", "acme/site", { target: { kind: "plugin", plugin: "pr-review", handler: "review-pull-request", config: { minSeverity: "high" } } }),
      reviewLine("l-team", "acme/api", { ownerType: "team", ownerId: "team-1" }),
      { ...reviewLine("l-other", "acme/web"), target: { kind: "assistant" } },
    ];
    renderPage();
    const list = screen.getByRole("region", { name: "Repositories" });
    expect(within(list).getByText("acme/site")).toBeTruthy();
    expect(within(list).queryByText("acme/api")).toBeNull();
    expect(within(list).queryByText("acme/web")).toBeNull();

    fireEvent.click(within(list).getByRole("button", { name: "Settings" }));
    expect((screen.getByLabelText("Min severity") as HTMLSelectElement).value).toBe("high");
    fireEvent.change(screen.getByLabelText("Min severity"), { target: { value: "low" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(patch).toHaveBeenCalledWith({ id: "l-site", body: { config: null } }, expect.anything());

    fireEvent.click(screen.getByRole("switch", { name: "Review pull requests in acme/site" }));
    expect(patch).toHaveBeenCalledWith({ id: "l-site", body: { enabled: false } }, expect.anything());
  });

  it("adds a repository as a PR review line with a repo condition", () => {
    subscriptions = [reviewLine("l-site", "acme/site")];
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Add repository" }));
    const combobox = screen.getByRole("combobox", { name: "Search repositories" });
    fireEvent.focus(combobox);
    // A repository that already has a line is not offered again.
    expect(screen.queryByRole("option", { name: /acme\/site/ })).toBeNull();
    fireEvent.click(screen.getByRole("option", { name: /acme\/api/ }));
    expect(create).toHaveBeenCalledWith({
      name: "Code review: acme/api",
      eventKeys: ["github.pull_request.opened", "github.pull_request.synchronize"],
      filters: [{ field: "repo", op: "eq", value: "acme/api" }],
      target: { kind: "plugin", plugin: "pr-review", handler: "review-pull-request" },
    }, expect.anything());
  });

  it("links each recent review to its pull request and plugin thread", () => {
    reviews = [{ repo: "acme/site", number: 7, reviewId: 41, head: "abc1234def", openFindings: 2, resolvedFindings: 1, updatedAt: Date.now(), threadId: "t-7" }];
    renderPage();
    const recent = screen.getByRole("region", { name: "Recent reviews" });
    expect(within(recent).getByRole("link", { name: "acme/site#7" }).getAttribute("href")).toBe("https://github.com/acme/site/pull/7#pullrequestreview-41");
    expect(within(recent).getByRole("link", { name: "Open thread" }).getAttribute("href")).toBe("/threads/t-7");
    expect(within(recent).getByText(/2 open findings, 1 fixed, at abc1234/)).toBeTruthy();
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
