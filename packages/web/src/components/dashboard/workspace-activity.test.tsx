// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { api, type OwnerFilter } from "~/api/client";
import { WorkspaceActivity, safeResultUrl } from "./workspace-activity";
let owner: OwnerFilter = { ownerType: "user", ownerId: "u" };
vi.mock("@tanstack/react-router", () => ({ Link: ({ children, to, params, search }: { children: ReactNode; to: string; params?: Record<string, string>; search?: { thread?: string } }) => <a href={Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to) + (search?.thread ? `?thread=${search.thread}` : "")}>{children}</a> }));
vi.mock("~/api/client", () => ({ api: { listArtifacts: vi.fn(), listWorkspaceOutcomes: vi.fn(), listWorkspaceActiveWork: vi.fn(), getWaitingThreads: vi.fn(async () => ({ threads: [] })), patchThread: vi.fn(async () => ({})), listWorkflows: vi.fn(), listRuns: vi.fn(), listWorkflowActionRequired: vi.fn(), dismissWorkflowRun: vi.fn(async () => ({ ok: true })) } }));
beforeEach(() => {
  vi.clearAllMocks(); owner = { ownerType: "user", ownerId: "u" };
  vi.mocked(api.listArtifacts).mockResolvedValue({ artifacts: [], nextCursor: null });
  vi.mocked(api.listWorkspaceOutcomes).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(api.listWorkspaceActiveWork).mockResolvedValue({ items: [], nextCursor: null });
  vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [{ id: "wf", name: "Review", definition: {}, ownerType: "user", ownerId: "u", createdAt: 1, updatedAt: 1 }] });
  vi.mocked(api.listRuns).mockResolvedValue({ runs: [] });
  vi.mocked(api.listWorkflowActionRequired).mockResolvedValue({ items: [], count: 0 });
});
function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(<QueryClientProvider client={client}><WorkspaceActivity owner={owner} /></QueryClientProvider>);
  return { client, ...view };
}
it("groups PRs and published files under their work with real source links", async () => {
  vi.mocked(api.listWorkspaceOutcomes).mockResolvedValue({ items: [{ id: "pr", kind: "pull_request", title: "Route events PR", occurredAt: 5, sessionId: "s", threadId: "thread-a", url: "https://github.com/acme/app/pull/42" }, { id: "unsafe", kind: "review", title: "Unsafe link", occurredAt: 4, url: "javascript:alert(1)" }], nextCursor: null });
  vi.mocked(api.listArtifacts).mockResolvedValue({ artifacts: [{ id: "a", title: "Routing report", path: "report.md", format: "markdown", icon: "", ownerType: "user", version: 1, sharedVersion: null, token: "report-token", url: "https://api.example/a/report-token", visibility: "org", actorUserId: "u", revoked: false, createdAt: 2, updatedAt: 3, sourceSessionId: "s", sourceThreadId: "thread-a" }], nextCursor: null });
  setup();
  const pr = await screen.findByRole("link", { name: "Route events PR" });
  const results = screen.getByRole("region", { name: "Recent results" });
  expect(pr.getAttribute("href")).toBe("https://github.com/acme/app/pull/42");
  expect(within(results).getByRole("link", { name: "Routing report" }).getAttribute("href")).toBe("/a/report-token");
  expect(within(results).getAllByRole("link", { name: "Open thread" })[0]?.getAttribute("href")).toBe("/threads/thread-a");
  expect(screen.queryByRole("link", { name: "Unsafe link" })).toBeNull();
  expect(screen.queryByText("Completed")).toBeNull();
});
it("dismisses a failed run from Needs attention", async () => {
  const failed = { runId: "failed-run", workflowId: "wf", status: "settled" as const, outcome: "failed" as const, createdAt: 1, updatedAt: 2 };
  vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [{ id: "wf", name: "Bug triage", definition: {}, ownerType: "user", ownerId: "u", createdAt: 1, updatedAt: 1, latestRun: failed }] });
  setup();
  const attention = await screen.findByRole("region", { name: "Needs attention" });
  vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [{ id: "wf", name: "Bug triage", definition: {}, ownerType: "user", ownerId: "u", createdAt: 1, updatedAt: 1, latestRun: { ...failed, dismissed: true } }] });
  fireEvent.click(within(attention).getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Needs attention" })).toBeNull());
  expect(api.dismissWorkflowRun).toHaveBeenCalledWith("failed-run");
});
it("shows one result row per thread or pull request, saying what happened", async () => {
  const messages = Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, kind: "message" as const, title: "Team Granola Integration Strategy", occurredAt: 100 - i, sessionId: "s", threadId: "granola", url: `https://slack.com/archives/C1/p${i}` }));
  const reviews = [1, 2].map((i) => ({ id: `r${i}`, kind: "review" as const, title: "Review submitted", occurredAt: 200 + i, workflowRunId: `run-${i}`, url: `https://github.com/acme/app/pull/42#pullrequestreview-${i}` }));
  vi.mocked(api.listWorkspaceOutcomes).mockResolvedValue({ items: [...reviews, ...messages], nextCursor: null });
  setup();
  const results = await screen.findByRole("region", { name: "Recent results" });
  expect(await within(results).findAllByText("Team Granola Integration Strategy")).toHaveLength(1);
  expect(within(results).getByText(/9 Slack messages/)).toBeTruthy();
  expect(within(results).getByRole("link", { name: "acme/app #42" }).getAttribute("href")).toBe("https://github.com/acme/app/pull/42");
  expect(within(results).getByText(/2 reviews/)).toBeTruthy();
  expect(within(results).queryByText("Review submitted")).toBeNull();
});
it("separates approval from timer waits and shows the requested action", async () => {
  vi.mocked(api.listWorkflows).mockResolvedValue({ workflows: [
    { id: "wf", name: "Review rollout", definition: {}, ownerType: "user", ownerId: "u", createdAt: 1, updatedAt: 1, latestRun: { runId: "approval", workflowId: "wf", status: "parked", createdAt: 1, updatedAt: 2 } },
    { id: "timer-wf", name: "Wait for intake", definition: {}, ownerType: "user", ownerId: "u", createdAt: 1, updatedAt: 1, latestRun: { runId: "timer", workflowId: "timer-wf", status: "parked", waitingOn: [{ kind: "timer", nodeId: "wait", wakeAt: 100 }], createdAt: 1, updatedAt: 2 } },
  ] });
  vi.mocked(api.listWorkflowActionRequired).mockResolvedValue({ items: [{ id: "g", runId: "approval", workflowId: "wf", workflowName: "Review rollout", runCreatedAt: 1, owner: { type: "user", id: "u" }, trigger: { type: "manual" }, gate: { nodeId: "review", kind: "approval", prompt: "Check the routing report before rollout." } }], count: 1 });
  setup();
  expect(await screen.findByText(/Check the routing report before rollout\./)).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "Needs attention" })).getByText("Review rollout")).toBeTruthy();
  expect(within(screen.getByRole("region", { name: "In progress" })).getByText("Wait for intake")).toBeTruthy();
  expect(api.listWorkflows).toHaveBeenCalledWith(expect.objectContaining(owner));
});
it("finds old active threads independently of recent work and resolves state precedence", async () => {
  vi.mocked(api.listWorkspaceActiveWork).mockResolvedValue({ items: [
    { id: "failed", sessionId: "old", threadId: "t", title: "Old failed", state: "failed", updatedAt: 30 },
    { id: "working", sessionId: "old", threadId: "t", title: "Old queued", state: "working", updatedAt: 20 },
    { id: "blocked", sessionId: "old", threadId: "t", title: "Old approval", state: "needs_you", updatedAt: 10 },
  ], nextCursor: null });
  setup();
  expect(await screen.findByRole("link", { name: "Old approval" })).toBeTruthy();
  expect(screen.queryByText("Old failed")).toBeNull();
  expect(screen.queryByText("Old queued")).toBeNull();
});
it("hides cached active work on an error without an all-clear empty state", async () => {
  vi.mocked(api.listWorkspaceActiveWork).mockResolvedValue({ items: [{ id: "q", sessionId: "s", threadId: "t", title: "Private approval", state: "needs_you", updatedAt: 1 }], nextCursor: "next" });
  const { client } = setup();
  expect(await screen.findByText("Private approval")).toBeTruthy();
  vi.mocked(api.listWorkspaceActiveWork).mockRejectedValue(new Error("denied"));
  await act(async () => { await client.refetchQueries({ queryKey: ["workspace-active-work"] }); });
  expect(await screen.findByText("Could not load active work.")).toBeTruthy();
  expect(screen.queryByText("Private approval")).toBeNull();
  expect(screen.queryByText("No attention items in the loaded work.")).toBeNull();
  expect(screen.queryByRole("button", { name: "Load more active work" })).toBeNull();
});
it("resets active paging and hides previous workspace results on scope change", async () => {
  vi.mocked(api.listWorkspaceActiveWork).mockImplementation(async (scope, cursor) => ({ items: [{ id: "q", sessionId: "s", threadId: "t", title: scope.ownerId === "u" ? "Personal item" : "Team item", state: "working", updatedAt: 1 }], nextCursor: cursor ? null : "next" }));
  const { rerender, client } = setup();
  fireEvent.click(await screen.findByRole("button", { name: "Load more active work" }));
  await waitFor(() => expect(api.listWorkspaceActiveWork).toHaveBeenCalledWith(owner, "next"));
  owner = { ownerType: "team", ownerId: "team" };
  rerender(<QueryClientProvider client={client}><WorkspaceActivity owner={owner} /></QueryClientProvider>);
  expect(screen.queryByText("Personal item")).toBeNull();
  expect(await screen.findByText("Team item")).toBeTruthy();
  expect(api.listWorkspaceActiveWork).toHaveBeenCalledWith(owner, undefined);
});
it("only accepts explicit HTTP result links", () => {
  expect(safeResultUrl("data:text/html,test")).toBeUndefined();
  expect(safeResultUrl("/relative/path")).toBeUndefined();
  expect(safeResultUrl("https://example.com/report")).toBe("https://example.com/report");
});
it("puts Valet's questions under Needs attention and plain replies in their own list, with Reply, Open thread, and Archive", async () => {
  vi.mocked(api.getWaitingThreads).mockResolvedValue({ threads: [
    { sessionId: "s", threadId: "ask", title: "Dependency bump", lastAgentActivityAt: 5, unread: true, question: "Should I merge it once CI passes?" },
    { sessionId: "s", threadId: "told", title: "Lockfile fix", lastAgentActivityAt: 4, unread: false, preview: "The lockfile pins typebox again." },
    { sessionId: "s", threadId: "busy", title: "Also active", lastAgentActivityAt: 3, unread: false, question: "Proceed?" },
  ] });
  vi.mocked(api.listWorkspaceActiveWork).mockResolvedValue({ items: [
    { id: "q", sessionId: "s", threadId: "busy", title: "Also active", state: "needs_you", updatedAt: 6 },
  ], nextCursor: null });
  setup();
  const attention = await screen.findByRole("region", { name: "Needs attention" });
  expect(await within(attention).findByText(/Should I merge it once CI passes\?/)).toBeTruthy();
  // Every row here already needs the reader, so none carries an unread dot.
  expect(within(attention).queryByRole("img", { name: "Unread" })).toBeNull();
  expect(within(attention).queryByText("Lockfile fix")).toBeNull();
  expect(within(attention).getAllByRole("link", { name: "Also active" })).toHaveLength(1);
  const replies = screen.getByRole("region", { name: "Conversation updates" });
  expect(within(replies).getByText(/The lockfile pins typebox again\./)).toBeTruthy();
  expect(within(replies).getByRole("link", { name: "Open thread" }).getAttribute("href")).toContain("told");
  expect(within(replies).queryByRole("link", { name: "Reply" })).toBeNull();
  expect(within(attention).getByRole("link", { name: "Reply" })).toBeTruthy();
  // The server stops listing an archived thread.
  vi.mocked(api.getWaitingThreads).mockResolvedValue({ threads: [
    { sessionId: "s", threadId: "ask", title: "Dependency bump", lastAgentActivityAt: 5, unread: true, question: "Should I merge it once CI passes?" },
  ] });
  fireEvent.click(within(replies).getByRole("button", { name: "Archive Lockfile fix" }));
  await waitFor(() => expect(api.patchThread).toHaveBeenCalledWith("told", { archived: true }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Conversation updates" })).toBeNull());
});
