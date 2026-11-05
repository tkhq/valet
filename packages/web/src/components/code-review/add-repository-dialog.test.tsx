// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import type { CreateEventSubscriptionRequest, EventSubscriptionFilterWire, EventSubscriptionWire, GetReposResponse } from "@valet/api/wire";
import { ApiError } from "~/api/api-error";
import type { HandlerOption } from "~/components/plugins/handler-settings";

vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, to, params, className }: { children: ReactNode; to: string; params?: Record<string, string>; className?: string }) => (
    <a href={Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to)} className={className}>{children}</a>
  ),
}));

const handler: HandlerOption = {
  plugin: "pr-review", id: "review-pull-request", label: "PR review", description: "Review pushes.",
  events: ["github.pull_request.opened", "github.pull_request.synchronize"],
};

function reviewLine(id: string, repo: string, overrides: Partial<EventSubscriptionWire> = {}): EventSubscriptionWire {
  return {
    id, name: `Code review: ${repo}`, ownerType: "user", ownerId: "u-1", eventKeys: handler.events,
    filters: [{ field: "repo", op: "eq", value: repo }],
    target: { kind: "plugin", plugin: handler.plugin, handler: handler.id },
    enabled: true, createdBy: "u-1", createdAt: 1, updatedAt: 1, ...overrides,
  };
}

const initialRepos: GetReposResponse = {
  connected: true, installed: true,
  repos: ["acme/site", "acme/api"].map((fullName) => ({
    fullName, url: `https://github.com/${fullName}`, cloneUrl: `https://github.com/${fullName}.git`, defaultBranch: "main", private: true,
  })),
};

let repos = initialRepos;
let reposLoading = false;
let reposError: Error | null = null;
let subscriptions: EventSubscriptionWire[] = [];
let subscriptionsLoading = false;
let subscriptionsError: Error | null = null;
let createPending = false;
let createError: Error | null = null;
const onAdded = vi.fn();
const onExisting = vi.fn();
const onOpenChange = vi.fn();
const refetchRepos = vi.fn();
const refetchSubscriptions = vi.fn();
const create = vi.fn((_body: CreateEventSubscriptionRequest, _options?: { onSuccess?: (response: { id: string }) => void }) => {});
const subscriptionsHook = vi.fn(() => ({
  data: { subscriptions }, isLoading: subscriptionsLoading, error: subscriptionsError, refetch: refetchSubscriptions,
}));

vi.mock("~/api/events", () => ({
  useEventSubscriptions: () => subscriptionsHook(),
  useCreateEventSubscription: () => ({ mutate: create, isPending: createPending, error: createError }),
}));
vi.mock("~/api/repos", () => ({
  useRepos: () => ({ data: repos, isLoading: reposLoading, error: reposError, refetch: refetchRepos }),
}));

import { AddRepositoryDialog } from "./add-repository-dialog";

function dialog(lines: EventSubscriptionWire[] = [], teamId?: string, open = true) {
  return <AddRepositoryDialog open={open} onOpenChange={onOpenChange} lines={lines} handler={handler} teamId={teamId} onAdded={onAdded} onExisting={onExisting} />;
}

beforeEach(() => {
  repos = initialRepos;
  reposLoading = false;
  reposError = null;
  subscriptions = [];
  subscriptionsLoading = false;
  subscriptionsError = null;
  createPending = false;
  createError = null;
  vi.clearAllMocks();
});

describe("AddRepositoryDialog", () => {
  it("opens a configured repository's settings instead of creating a duplicate", () => {
    const line = reviewLine("site-line", "ACME/SITE");
    subscriptions = [line];
    render(dialog([line]));
    const panel = screen.getByRole("dialog", { name: "Add a repository" });
    expect(within(panel).getByText("Configured")).toBeTruthy();
    fireEvent.click(within(panel).getByRole("button", { name: /acme\/site.*Manage/ }));
    expect(onExisting).toHaveBeenCalledWith("site-line");
    expect(create).not.toHaveBeenCalled();
  });

  it("keeps disabled review lines available to manage", () => {
    const line = reviewLine("site-line", "acme/site", { enabled: false });
    render(dialog([line]));
    fireEvent.click(screen.getByRole("button", { name: /acme\/site.*Reviews off.*Manage/ }));
    expect(onExisting).toHaveBeenCalledWith("site-line");
    expect(create).not.toHaveBeenCalled();
  });

  it("matches an in condition without case sensitivity", () => {
    const line = reviewLine("multi-line", "acme/site", { filters: [{ field: "repo", op: "in", value: ["ACME/SITE", "acme/api"] }] });
    render(dialog([line]));
    fireEvent.click(screen.getByRole("button", { name: /acme\/api.*Manage/ }));
    expect(onExisting).toHaveBeenCalledWith("multi-line");
    expect(create).not.toHaveBeenCalled();
  });

  it.each<{ name: string; filters: EventSubscriptionFilterWire[] }>([
    { name: "prefix", filters: [{ field: "repo", op: "prefix", value: "acme/" }] },
    { name: "contains", filters: [{ field: "repo", op: "contains", value: "/api" }] },
    { name: "regex", filters: [{ field: "repo", op: "regex", value: "^acme/(api|other)$" }] },
    { name: "not_in", filters: [{ field: "repo", op: "not_in", value: ["acme/site"] }] },
    { name: "not_prefix", filters: [{ field: "repo", op: "not_prefix", value: "other/" }] },
    { name: "not_regex", filters: [{ field: "repo", op: "not_regex", value: "^other/" }] },
    { name: "combined", filters: [{ field: "repo", op: "prefix", value: "acme/" }, { field: "repo", op: "not_in", value: ["acme/site"] }] },
  ])("opens the existing configuration when $name filters cover the repository", ({ filters }) => {
    const line = reviewLine("matching-line", "acme/api", { filters });
    render(dialog([line]));
    fireEvent.click(screen.getByRole("button", { name: /acme\/api.*Manage/ }));
    expect(onExisting).toHaveBeenCalledWith("matching-line");
    expect(create).not.toHaveBeenCalled();
  });

  it.each<{ name: string; filters: EventSubscriptionFilterWire[] }>([
    { name: "not_in", filters: [{ field: "repo", op: "not_in", value: ["acme/api"] }] },
    { name: "not_prefix", filters: [{ field: "repo", op: "not_prefix", value: "acme/" }] },
    { name: "not_regex", filters: [{ field: "repo", op: "not_regex", value: "^acme/" }] },
    { name: "contradictory conditions", filters: [{ field: "repo", op: "eq", value: "acme/api" }, { field: "repo", op: "in", value: ["acme/site"] }] },
    { name: "an exclusion after an exact match", filters: [{ field: "repo", op: "eq", value: "acme/api" }, { field: "repo", op: "not_in", value: ["acme/api"] }] },
    { name: "an invalid regex", filters: [{ field: "repo", op: "regex", value: "[" }] },
  ])("allows adding when $name prevents the existing line from covering the repository", ({ filters }) => {
    const line = reviewLine("nonmatching-line", "acme/api", { filters });
    render(dialog([line]));
    fireEvent.click(screen.getByRole("button", { name: /acme\/api.*Add/ }));
    expect(onExisting).not.toHaveBeenCalled();
    expect(create).toHaveBeenCalledOnce();
  });

  it("uses a broad review line for each covered repository", () => {
    const line = reviewLine("all-repos", "all", { filters: [] });
    render(dialog([line]));
    fireEvent.click(screen.getByRole("button", { name: /acme\/api.*Manage/ }));
    expect(onExisting).toHaveBeenCalledWith("all-repos");
    expect(create).not.toHaveBeenCalled();
  });

  it("links to a configuration in another workspace without creating one", () => {
    subscriptions = [reviewLine("personal-line", "acme/site")];
    render(dialog([], "team-1"));
    expect(screen.getByText("Configured in another workspace")).toBeTruthy();
    expect(screen.getByRole("link", { name: /acme\/site.*Open configuration/ }).getAttribute("href")).toBe("/presence/rules/personal-line");
    expect(screen.queryByRole("button", { name: /acme\/site/ })).toBeNull();
    expect(create).not.toHaveBeenCalled();
  });

  it("allows review here when another workspace's configuration is off", () => {
    subscriptions = [reviewLine("personal-line", "acme/site", { enabled: false })];
    render(dialog([], "team-1"));
    expect(screen.getByText("Reviews off in another workspace")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open configuration" }).getAttribute("href")).toBe("/presence/rules/personal-line");
    fireEvent.click(screen.getByRole("button", { name: /acme\/site.*Add/ }));
    expect(create).toHaveBeenCalledOnce();
  });

  it("does not treat a nonmatching regex as covering every repository", () => {
    subscriptions = [reviewLine("pattern-line", "acme/site", { filters: [{ field: "repo", op: "regex", value: "^other/" }] })];
    render(dialog());
    fireEvent.click(screen.getByRole("button", { name: /acme\/api.*Add/ }));
    expect(create).toHaveBeenCalledOnce();
  });

  it("filters all repository choices and reports no matching results", () => {
    render(dialog());
    const search = screen.getByRole("searchbox", { name: "Search repositories" });
    fireEvent.change(search, { target: { value: "API" } });
    expect(screen.getByRole("button", { name: /acme\/api.*Add/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /acme\/site/ })).toBeNull();
    fireEvent.change(search, { target: { value: "missing" } });
    expect(screen.getByText("No matching repositories. Try another search.")).toBeTruthy();
  });

  it("adds an unconfigured repository with the active team and opens its settings", () => {
    create.mockImplementationOnce((_body, options) => options?.onSuccess?.({ id: "new-line" }));
    render(dialog([], "team-1"));
    fireEvent.click(screen.getByRole("button", { name: /acme\/api.*Add/ }));
    expect(create).toHaveBeenCalledWith({
      name: "Code review: acme/api", eventKeys: handler.events,
      filters: [{ field: "repo", op: "eq", value: "acme/api" }],
      target: { kind: "plugin", plugin: handler.plugin, handler: handler.id, teamId: "team-1" },
    }, expect.anything());
    expect(onAdded).toHaveBeenCalledWith("new-line");
  });

  it("waits for all configurations before offering an add action", () => {
    subscriptionsLoading = true;
    render(dialog());
    expect(screen.getByText("Loading review configurations…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /acme\/api/ })).toBeNull();
  });

  it("shows repository loading before choices are available", () => {
    reposLoading = true;
    render(dialog());
    expect(screen.getByText("Loading repositories…")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /acme\/api/ })).toBeNull();
  });

  it("explains how to fix an empty repository list", () => {
    repos = { ...initialRepos, repos: [] };
    render(dialog());
    expect(screen.getByText("No repositories are available. Check GitHub access in Integrations.")).toBeTruthy();
  });

  it("explains how to install the GitHub App before adding repositories", () => {
    repos = { ...initialRepos, installed: false };
    render(dialog());
    expect(screen.getByText(/Ask an org admin to install it in Settings/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /acme\/api/ })).toBeNull();
  });

  it("does not treat other plugin handlers as code review configurations", () => {
    subscriptions = [reviewLine("other-line", "acme/api", { target: { kind: "assistant" } })];
    render(dialog());
    fireEvent.click(screen.getByRole("button", { name: /acme\/api.*Add/ }));
    expect(create).toHaveBeenCalledOnce();
  });

  it("prefers this workspace's configuration when other workspaces also cover the repository", () => {
    const local = reviewLine("local-line", "acme/site", { ownerType: "team", ownerId: "team-1" });
    subscriptions = [reviewLine("personal-line", "acme/site"), local];
    render(dialog([local], "team-1"));
    fireEvent.click(screen.getByRole("button", { name: /acme\/site.*Manage/ }));
    expect(onExisting).toHaveBeenCalledWith("local-line");
    expect(create).not.toHaveBeenCalled();
  });

  it("shows a retry action when repositories fail to load", () => {
    reposError = new Error("unavailable");
    render(dialog());
    expect(screen.getByRole("alert").textContent).toContain("Valet cannot load repositories");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetchRepos).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: /acme\/api/ })).toBeNull();
  });

  it("shows a retry action when review configurations fail to load", () => {
    subscriptionsError = new Error("unavailable");
    render(dialog());
    expect(screen.getByRole("alert").textContent).toContain("Valet cannot load review configurations");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(refetchSubscriptions).toHaveBeenCalledOnce();
    expect(create).not.toHaveBeenCalled();
  });

  it("locks choices and search during creation", () => {
    createPending = true;
    render(dialog());
    expect(screen.getByRole("searchbox", { name: "Search repositories" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: /acme\/api.*Add/ }));
    expect(create).not.toHaveBeenCalled();
    expect(screen.getByRole("status").textContent).toContain("Adding repository…");
  });

  it("provides an existing configuration link when a competing write causes a collision", () => {
    const line = reviewLine("concurrent-line", "acme/api");
    createError = new ApiError(409, "conflict", { collisions: { blocking: [{ subscription: line, relation: "equal", sharedKeys: handler.events }], overlapping: [] } });
    render(dialog());
    expect(screen.getByRole("alert").textContent).toContain("Already configured");
    expect(screen.getByRole("link", { name: line.name }).getAttribute("href")).toBe("/presence/rules/concurrent-line");
    expect(screen.queryByRole("button", { name: /anyway/i })).toBeNull();
  });

  it("gives a Presence action for a conflict without a collision payload", () => {
    createError = new ApiError(409, "conflict");
    render(dialog());
    expect(screen.getByRole("alert").textContent).toContain("Already configured. Open its configuration in Presence.");
    expect(screen.getByRole("link", { name: "Open Presence" }).getAttribute("href")).toBe("/presence");
  });

  it("does not load the dialog body until it opens", () => {
    const view = render(dialog([], undefined, false));
    expect(subscriptionsHook).not.toHaveBeenCalled();
    view.rerender(dialog());
    expect(subscriptionsHook).toHaveBeenCalled();
  });
});
